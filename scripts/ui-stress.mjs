import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {testProfile,launchTestContext,freshWorker} from './harness.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const extension=path.resolve(root,process.env.COMIC_BUILD_DIR??'.output/chrome-mv3');
const run=process.env.COMIC_UI_STRESS_RUN??'current';
const strict=process.env.COMIC_UI_STRESS_STRICT==='1';
assert(/^[a-z][a-z0-9-]*$/.test(run));
const output=path.join(root,'artifacts/ui-polish',run);
const image=await readFile(path.join(root,'artifacts/corpus/pages/page-01.png'));
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
const cases=['demo','worst','empty','one'];
const origin='https://moyu-ui-stress.test';
const imageUrl='data:image/png;base64,'+image.toString('base64');
const fileHash=createHash('sha256').update(image).digest('hex');
const makeRegion=order=>({
  id:'frame-'+order,kind:'bubble',render:'auto',order,score:.93,
  x:30+(order%15)*64,y:30+Math.floor(order/15)*70,width:54,height:62,
  source:'ここで待っていて。',translation:'請在這裡等我。',ocrDone:true,warnings:[]
});
// Values fit the correction contract: 300 regions, 1,500 characters per
// source, and a 300-character maximum for each OCR-candidate warning.
const longId=('serial-file-19f84bfea1ca478ca0e74fe337d915dd').repeat(6);
const diagnostic=('模型讀取中斷 https://models.example.test/manga-ocr/'+longId).slice(0,300);
const paragraph='王都の図書館を出たとき、彼女は広場へ戻ると言った。手紙の宛名には遠い町の名前があったので、地図を広げて確かめた。';
const candidateText=(paragraph.repeat(35)).slice(0,1450)+' 星の記録';
const candidate=(source,warnings=[])=>({
  source,profile:'fp32',identity:'fixture',preprocessing:'canvas',decoder:'kv',
  backend:'wasm/wasm/wasm',warnings,at:1
});
const fixture={
  demo:[makeRegion(0),makeRegion(1)],
  worst:Array.from({length:300},(_,index)=>index===0?{
    ...makeRegion(index),source:'入り口の記録 '+longId,translation:'',
    warnings:[diagnostic,'原文の行順を確認してください。'],
    ocrCandidates:[candidate('前の候補 '+longId),candidate(candidateText,[diagnostic])]
  }:{...makeRegion(index),translation:''}),
  empty:[],
  one:[{...makeRegion(0),source:'あ。',translation:'',ocrCandidates:[candidate('')]}]
};
const report={version:manifest.version,layout:[],keyboardScroll:false,errors:[]};
await mkdir(output,{recursive:true});
const context=await launchTestContext(chromium,await testProfile(root,'e2e'),{
  channel:'chromium',headless:true,viewport:{width:1280,height:820},
  args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--host-resolver-rules=MAP * ~NOTFOUND','--no-proxy-server']
});
context.setDefaultTimeout(15000);
context.on('page',page=>page.on('pageerror',error=>report.errors.push(error.message)));
await context.route(origin+'/**',route=>{
  const name=new URL(route.request().url()).searchParams.get('fixture');
  const count=name==='worst'?60:1;
  const navigation=cases.map(value=>`<a href="?fixture=${value}">${value}</a>`).join(' · ');
  const panels=Array.from({length:count},(_,index)=>`<img width="620" src="${imageUrl}#${index}" alt="原創圖 ${index+1}">`).join('');
  return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><title>墨譯壓力測試</title><nav aria-label="測試資料">${navigation}</nav><main data-comic-reader>${panels}</main>`});
});
try {
  const worker=await freshWorker(context);
  const options=await context.newPage();
  await options.goto(`chrome-extension://${worker.url().split('/')[2]}/options.html`);
  const site=await context.newPage();
  await site.goto(origin+'/?fixture=demo');
  const tabId=await worker.evaluate(prefix=>chrome.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url?.startsWith(prefix))?.id),origin);
  assert(tabId);
  for(const name of cases){
    await site.getByRole('link',{name,exact:true}).click();
    await site.locator('main img').first().evaluate(img=>img.decode());
    const activated=await options.evaluate(tabId=>chrome.runtime.sendMessage({channel:'activate-page',tabId}),tabId);
    assert(activated.ok,activated.error);
    const dock=site.getByRole('region',{name:'墨譯章節翻譯'});
    await dock.getByRole('button',{name:'章節工作台',exact:true}).click();
    const editor=site.getByRole('dialog',{name:'章節工作台',exact:true});
    await editor.locator('canvas').waitFor();
    await editor.getByText('頁面工具',{exact:true}).click();
    const imported=context.waitForEvent('page');
    await editor.getByRole('button',{name:'載入校正（獨立分頁）'}).click();
    const importer=await imported;
    await importer.locator('input[type=file]').setInputFiles({
      name:`原創樣本-${name}.json`,mimeType:'application/json',
      buffer:Buffer.from(JSON.stringify({schema:1,hash:fileHash,width:1000,height:1500,regions:fixture[name]}))
    });
    await importer.getByRole('button',{name:'匯入到工作台'}).click();
    await editor.getByText('校正已匯入，可套用至漫畫頁').waitFor();
    await importer.close();
    if(await editor.getByRole('button',{name:'載入校正（獨立分頁）'}).isVisible()){
      await editor.getByText('頁面工具',{exact:true}).click();
    }
    const frames=editor.getByLabel('選擇文字框',{exact:true});
    assert.equal(await frames.count(),fixture[name].length?1:0);
    if(fixture[name].length){
      await frames.selectOption('frame-0');
      assert.equal(await editor.getByRole('textbox',{name:'日文原文'}).inputValue(),fixture[name][0].source);
    }
    if(name==='one')await editor.locator('.candidate-text').filter({hasText:'（空結果）'}).waitFor();
    if(name==='worst'&&strict){
      const reading=editor.getByRole('region',{name:'候選文字與差異',exact:true});
      await editor.getByRole('button',{name:'採用新原文',exact:true}).focus();
      await site.keyboard.press('Shift+Tab');
      assert(await reading.evaluate(el=>el.getRootNode().activeElement===el));
      await site.keyboard.press('ArrowDown');
      await site.waitForFunction(()=>document.querySelector('[data-comic-studio]').shadowRoot.querySelector('.candidate-reading').scrollTop>0);
      report.keyboardScroll=true;
    }
    for(const size of [{width:1280,height:820},{width:390,height:660},{width:320,height:480}]){
      await site.setViewportSize(size);
      await site.emulateMedia({reducedMotion:size.width===320?'reduce':'no-preference'});
      await editor.getByRole('button',{name:'套用至漫畫頁',exact:true}).waitFor();
      const measure=await editor.evaluate(dialog=>{
        const panels=Array.from(dialog.querySelectorAll('aside,.candidate,.mx-warning,.candidate small,.status'));
        const overflow=panels.map(node=>({element:node.tagName+'.'+node.classList[0],pixels:node.scrollWidth-node.clientWidth}))
          .filter(value=>value.pixels>1);
        const box=dialog.getBoundingClientRect();
        const applyButton=dialog.querySelector('footer button.primary');
        const apply=applyButton.getBoundingClientRect();
        const candidate=dialog.querySelector('.candidate');
        return {
          dialogOverflow:dialog.scrollWidth-dialog.clientWidth,
          panelOverflow:Math.max(0,...overflow.map(value=>value.pixels)),
          overflow,
          candidateHeight:Math.round(candidate?.getBoundingClientRect().height??0),
          historyCount:candidate?.querySelectorAll('details').length??0,
          actionMotion:getComputedStyle(applyButton).transitionDuration,
          applyVisible:apply.top>=box.top&&apply.bottom<=box.bottom+.5&&apply.right<=box.right+.5,
          regionOptions:dialog.querySelector('[aria-label="選擇文字框"]')?.options.length??0,
          visibleThumbs:dialog.querySelector('nav.rail')?.checkVisibility()?dialog.querySelector('nav.rail').children.length:0
        };
      });
      report.layout.push({fixture:name,...size,...measure});
      if((name==='demo'||name==='worst')&&size.width!==390){
        if(size.width===320&&name==='worst')await editor.getByRole('region',{name:'OCR 候選比較'}).locator('h3').scrollIntoViewIfNeeded();
        await editor.screenshot({path:path.join(output,`${name}-${size.width}.png`)});
      }
    }
    await site.keyboard.press('Escape');
    await editor.waitFor({state:'hidden'});
    await site.setViewportSize({width:1280,height:820});
  }
  assert.deepEqual(report.errors,[]);
  if(strict){
    assert(report.layout.every(m=>m.applyVisible&&m.dialogOverflow<=1&&m.panelOverflow<=1));
    assert(report.layout.filter(m=>m.fixture==='worst').every(m=>m.candidateHeight<450&&m.regionOptions===300));
    assert(report.layout.filter(m=>m.fixture==='one').every(m=>m.historyCount===0));
    assert(report.layout.filter(m=>m.width===320).every(m=>m.actionMotion==='0s'));
  }
  report.status='passed';
} catch(error) {
  report.status='failed';
  report.error=String(error);
  process.exitCode=1;
} finally {
  await context.close();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({version:report.version,status:report.status,error:report.error,
    findings:report.layout.filter(m=>m.panelOverflow>1||m.dialogOverflow>1||!m.applyVisible||m.candidateHeight>450||m.fixture==='one'&&m.historyCount),
    cases:report.layout.length}));
}
