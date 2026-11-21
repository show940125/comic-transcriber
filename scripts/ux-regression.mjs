import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {testProfile,launchTestContext,freshWorker} from './harness.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const channel=process.env.TEST_BROWSER??'chromium';
assert(['chromium','msedge'].includes(channel));
const extension=path.resolve(root,process.env.COMIC_BUILD_DIR??'.output/chrome-mv3');
const output=path.join(path.resolve(root,process.env.COMIC_UX_REPORT_ROOT??'artifacts/ux-acceptance'),channel);
const source=await readFile(path.join(root,'artifacts/corpus/pages/page-01.png'));
const images=[source,Buffer.concat([source,Buffer.from('original-fixture-page-2')])];
const hashes=images.map(bytes=>createHash('sha256').update(bytes).digest('hex'));
const testUrl='https://moyu-ux.test/';
const html='<title>原創漫畫 UX 驗收</title><main data-comic-reader>'+images.map((bytes,i)=>'<img id="page-'+i+'" width="700" src="data:image/png;base64,'+bytes.toString('base64')+'">').join('')+'</main>';
const report={channel,status:'running',checks:[],errors:[],fixture:'原創漫畫、隔離 profile，偵測／OCR／Google／Gemini 使用固定回覆'};
await mkdir(output,{recursive:true});
const context=await launchTestContext(chromium,await testProfile(root,'e2e'),{channel,headless:true,viewport:{width:1280,height:900},args:[
  '--disable-extensions-except='+extension,'--load-extension='+extension,'--host-resolver-rules=MAP * ~NOTFOUND','--no-proxy-server'
]});
context.setDefaultTimeout(10000);
context.on('page',page=>page.on('pageerror',e=>report.errors.push(e.message)));
await context.route(testUrl+'**',r=>r.fulfill({contentType:'text/html',body:html}));
let site,reader;
try{
  const worker=await freshWorker(context),base='chrome-extension://'+worker.url().split('/')[2]+'/';
  await worker.evaluate(()=>{
    const fetchOriginal=fetch,send=chrome.runtime.sendMessage.bind(chrome.runtime),contains=chrome.permissions.contains.bind(chrome.permissions);
    const fixture={google:0,gemini:0,ocr:0,hold:false,pending:new Map(),denyGemini:true,holdSecondOcr:false,holdGoogle:false};
    globalThis.ux=fixture;
    chrome.permissions.contains=(grant,...rest)=>fixture.denyGemini&&grant.origins?.some(x=>x.includes('gemini.google.com'))?Promise.resolve(false):contains(grant,...rest);
    globalThis.fetch=async(input,init)=>{
      if(new URL(typeof input==='string'?input:input.url??input.href).hostname!=='translate.googleapis.com')return fetchOriginal(input,init);
      fixture.google++;
      if(fixture.holdGoogle)await new Promise(resolve=>{fixture.releaseGoogle=resolve;});
      return Response.json([[['這是初譯。','ねこです。']]]);
    };
    const region=(id,x,order)=>({id,x,y:70,width:170,height:150,order,source:'',translation:'',kind:'bubble',score:.93,render:'overlay',warnings:[]});
    chrome.runtime.sendMessage=(m,...rest)=>{
      if(m.channel==='offscreen-gemini'&&m.op==='refine'){
        fixture.gemini++;
        return chrome.storage.local.set({geminiUnknown:{fixture:{status:'unknown'}}}).then(()=>({ok:false,state:'unknown',error:'Gemini 回覆中斷'}));
      }
      if(m.channel==='offscreen-cancel'&&fixture.pending.has(m.id)){
        fixture.pending.get(m.id)();fixture.pending.delete(m.id);
        return Promise.resolve({ok:true});
      }
      if(m.channel!=='offscreen'||fixture.actualModels||!['detect','ocr'].includes(m.request.op))return send(m,...rest);
      if(m.request.op==='detect')return Promise.resolve({ok:true,result:[region('right',640,0),region('left',140,1)]});
      fixture.ocr++;
      const {profile}=m.request;
      const result=m.request.regions.map(r=>{
        const source=profile==='fp32'?'新しいねこだ。':'ねこです。',needsReview=profile!=='fp32'&&r.id==='right';
        return {...r,source,translation:'',initialTranslation:undefined,ocrDone:true,needsReview,warnings:needsReview?['日文待核對']:[],ocr:{source,profile,identity:'original-fixture',preprocessing:'fixture',decoder:profile==='fp32'?'kv':'standard',backend:'wasm-fixture',warnings:[],at:1}};
      });
      return fixture.hold||fixture.holdSecondOcr&&fixture.ocr===2
        ? new Promise(resolve=>fixture.pending.set(m.id,()=>resolve({ok:true,result})))
        : Promise.resolve({ok:true,result});
    };
  });
  const options=await context.newPage();await options.goto(base+'options.html');
  const mode=p=>p.getByLabel('整章翻譯模式',{exact:true});
  const button=(p,name)=>p.getByRole('button',{name,exact:true});
  const dockMode=(p,name)=>button(p.getByRole('group',{name:'整章翻譯模式',exact:true}),name);
  const status=(p,hasText)=>p.getByRole('status').filter({hasText});
  const activate=async(page,url)=>{
    await page.goto(url);
    await page.locator('#page-0').evaluate(i=>i.decode());
    const tabs=await worker.evaluate(()=>chrome.tabs.query({}));
    const tab=tabs.find(t=>t.url===url);assert(tab);
    const activation=await options.evaluate(tabId=>chrome.runtime.sendMessage({channel:'activate-page',tabId}),tab.id);
    assert.equal(activation.ok,true,JSON.stringify(activation));
    await page.getByRole('region',{name:'墨譯章節翻譯'}).waitFor();
  };
  site=await context.newPage();const sibling=await context.newPage();
  await activate(site,testUrl+'one');await activate(sibling,testUrl+'two');
  const dock=site.getByRole('region',{name:'墨譯章節翻譯'});
  const readingProgress=dock.getByRole('progressbar',{name:'整章可閱讀進度'});
  assert.equal(await readingProgress.getAttribute('max'),'2');
  assert.equal(await readingProgress.getAttribute('value'),'0');
  assert.equal(await button(dock,'整章 Gemini 校正').count(),0);
  await dockMode(site,'整章直譯').click();
  await button(dock,'前往 Gemini 設定').waitFor();
  await dock.getByText('請到設定授權 Gemini 網站。',{exact:true}).waitFor();
  assert.equal(await dockMode(sibling,'逐張初譯').getAttribute('aria-pressed'),'true');
  assert.equal(await mode(options).inputValue(),'standard');
  await site.reload();await site.locator('#page-0').evaluate(i=>i.decode());
  await activate(site,testUrl+'one');await button(dock,'前往 Gemini 設定').waitFor();
  assert.equal(await dockMode(site,'整章直譯').getAttribute('aria-pressed'),'true');
  await dockMode(site,'逐張初譯').click();
  report.checks.push('兩個分頁與全域預設獨立，重載後保留所選模式；Gemini 缺權限可前往設定');

  await worker.evaluate(async()=>{Object.assign(globalThis.ux,{denyGemini:false,holdSecondOcr:true,holdGoogle:true});await chrome.storage.local.set({geminiValidation:{status:'blocked',completed:0}});});
  await button(dock,'翻譯本章').click();
  await dock.locator('[data-phase=ocr][data-status=running]').waitFor();
  await dock.locator('[data-phase=translate][data-status=running]').waitFor();
  await worker.evaluate(async()=>{
    const until=performance.now()+5000;
    while((!globalThis.ux.releaseGoogle||!globalThis.ux.pending.size)&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
    if(!globalThis.ux.releaseGoogle||!globalThis.ux.pending.size)throw Error('Two in-flight jobs not observed');
  });
  assert.equal(await readingProgress.getAttribute('value'),'0');
  await dock.screenshot({path:path.join(output,'chapter-progress.png'),animations:'disabled'});
  await button(dock,'停止佇列').click();
  await worker.evaluate(()=>{
    const fixture=globalThis.ux;
    fixture.holdSecondOcr=false;fixture.holdGoogle=false;fixture.releaseGoogle();
    for(const release of fixture.pending.values())release();
    fixture.pending.clear();
  });
  await status(dock,'已有 2／2 張可以閱讀').waitFor({timeout:45000});
  assert.equal(await readingProgress.getAttribute('value'),'2');
  assert.equal(await dock.locator('[data-phase=render]').getAttribute('data-status'),'done');
  await dock.locator('[data-phase=ocr] summary').click();
  await status(dock,'已停止佇列。已完成的圖片與文字保留。').waitFor();
  report.checks.push('原生內容腳本兩頁 OCR／翻譯並行，停止後在途圖片仍完成，套用後才增加可讀頁');
  await dock.getByText(/第 1 張 · .*原文|第 1 張 · .*OCR/).waitFor();
  await dock.locator('[data-phase=ocr] summary').click();
  await dock.getByText('請到設定準備 Gemini。',{exact:false}).first().waitFor();
  assert.equal(await button(dock,'整章 Gemini 校正').count(),0);
  assert.equal(await worker.evaluate(()=>globalThis.ux.gemini),0);
  await worker.evaluate(()=>chrome.storage.local.set({geminiValidation:{status:'passed',completed:30}}));
  await button(dock,'整章 Gemini 校正').click();
  await dock.getByRole('alert').filter({hasText:'Gemini 回覆結果未知'}).waitFor();
  await dock.locator('[data-phase=gemini][data-status=held]').getByText('待確認',{exact:true}).waitFor();
  await status(dock,'已有 2／2 張可以閱讀').waitFor();
  assert.equal(await button(dock,'整章 Gemini 校正').count(),0);
  const diagnosticTab=context.waitForEvent('page');
  await button(dock,'查看請求紀錄').click();
  const diagnostics=await diagnosticTab;
  await diagnostics.waitForURL(/options[.]html#gemini-diagnostics$/);
  assert.equal(await diagnostics.locator('#gemini-diagnostics').getAttribute('open'),'');
  await diagnostics.close();
  assert.equal(await worker.evaluate(()=>globalThis.ux.gemini),1);
  report.checks.push('初譯完成後回報可讀頁數；準備前不送 Gemini，未知結果保留譯圖且導向紀錄');

  const opener=button(dock,'章節工作台');
  await opener.click();
  const editor=site.getByRole('dialog',{name:'章節工作台',exact:true});
  await editor.waitFor();
  assert.equal(await editor.locator('h1').evaluate(e=>e===e.getRootNode().activeElement),true);
  for(let i=0;i<8;i++){
    await site.keyboard.press('Tab');
    assert.equal(await editor.evaluate(e=>e.contains(e.getRootNode().activeElement)),true);
  }
  await site.keyboard.press('Escape');await editor.waitFor({state:'hidden'});
  assert.equal(await opener.evaluate(e=>e===e.getRootNode().activeElement),true);
  await opener.click();
  const original=editor.getByLabel('日文原文',{exact:true}),translated=editor.getByLabel('繁中譯文',{exact:true});
  const select=editor.getByLabel('選擇文字框',{exact:true});
  await select.selectOption('right');assert.equal(await original.inputValue(),'ねこです。');
  const views=editor.getByRole('group',{name:'比較原圖與譯圖'});
  await button(views,'譯圖').press('ArrowLeft');
  assert.equal(await button(views,'原圖').getAttribute('aria-pressed'),'true');
  await button(views,'原圖').press('ArrowRight');
  assert.equal(await button(views,'譯圖').getAttribute('aria-pressed'),'true');
  const editors=editor.getByRole('group',{name:'校正項目'});
  await button(editors,'文字').press('ArrowRight');
  await editor.getByRole('combobox',{name:/呈現方式/}).waitFor();
  await button(editors,'排版').press('ArrowLeft');
  await original.waitFor();
  report.checks.push('Smooth Tab 的方向鍵切換原圖、譯圖與文字、排版');
  const frameTools=()=>editor.getByText('文字框工具',{exact:true}).click();
  const menu=()=>editor.getByText('頁面工具',{exact:true}).click();
  await frameTools();await button(editor,'拆框').click();
  await button(editor,'預覽拆框').click();
  await status(editor,'1 右框 → 2 左框').waitFor();
  await select.selectOption('left');
  assert.equal(await button(editor,'套用拆框').count(),0);
  assert.equal(await translated.inputValue(),'這是初譯。');
  const readCache=()=>worker.evaluate(async hash=>{
    const data=await chrome.storage.local.get(null);
    return Object.values(data).find(x=>x?.schema===1&&x.hash===hash&&JSON.parse(x.modelKey)[1]==='google-web');
  },hashes[0]);
  const before=await readCache();
  assert.equal(before.regions.length,2);
  await select.selectOption('right');await frameTools();await button(editor,'拆框').click();
  await editor.getByLabel('分割方向',{exact:true}).selectOption('y');await button(editor,'預覽拆框').click();
  await status(editor,'1 上框 → 2 下框').waitFor();await button(editor,'套用拆框').click();
  await button(editor,'撤銷拆框').waitFor();
  const split=await readCache();assert.equal(split.regions.length,3);assert.equal(split.regions.find(r=>r.id==='left').translation,'這是初譯。');
  await button(editor,'撤銷拆框').click();await status(editor,'已撤銷拆框').waitFor();
  assert.deepEqual(await readCache(),before);
  report.checks.push('拆框預覽後切換框無法錯套；鍵盤替代操作、讀序、寫回及撤銷逐框驗證');

  await menu();await button(editor,'整頁重辨識').click();
  const confirm=site.getByRole('dialog',{name:'重辨識整張圖片？'});
  await confirm.getByText('範圍為這張圖的 2 個框',{exact:false}).waitFor();
  await site.keyboard.press('Escape');await confirm.waitFor({state:'hidden'});await editor.waitFor();
  assert.deepEqual(await readCache(),before);
  await button(editor,'整頁重辨識').click();
  await worker.evaluate(()=>{globalThis.ux.hold=true;});
  await button(confirm,'確認重辨識').click();
  await worker.evaluate(async()=>{
    const until=performance.now()+5000;
    while(!globalThis.ux.pending.size&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,50));
    if(!globalThis.ux.pending.size)throw Error('the isolated OCR operation did not start');
  });
  const releasePage=await context.newPage();await releasePage.goto(base+'cache.html');
  await button(releasePage,'釋放閒置模型').click();
  await status(releasePage,'等目前的工作收尾後釋放模型。').waitFor();
  await site.bringToFront();
  await button(editor,'取消').click();
  await status(editor,'已取消，原結果已保留').waitFor();
  await status(releasePage,'模型已從記憶體釋放。').waitFor();await releasePage.close();
  assert.deepEqual(await readCache(),before);
  await worker.evaluate(()=>{globalThis.ux.hold=false;});
  await button(editor,'整頁重辨識').click();
  await button(confirm,'確認重辨識').click();
  await button(editor,'撤銷整頁重辨識').waitFor();
  assert.equal((await readCache()).regions.find(r=>r.id==='left').translation,'');
  await button(editor,'撤銷整頁重辨識').click();
  await status(editor,'已撤銷整頁重辨識').waitFor();
  assert.deepEqual(await readCache(),before);
  if(await button(editor,'整頁重辨識').isVisible())await menu();
  report.checks.push('整頁重辨確認、Esc、推論中取消、成功後撤銷，快取重新讀回原內容');

  await select.selectOption('right');
  await button(editor,'使用另一模式比較').click();
  await editor.getByText('採用後，此框需要重新翻譯',{exact:true}).waitFor();
  assert.equal(await original.inputValue(),'ねこです。');
  report.contrast=await editor.evaluate(dialog=>{
    const channels=color=>color.match(/[\d.]+/g).slice(0,3).map(value=>{
      const n=Number(value)/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;
    });
    const luminance=color=>channels(color).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    const background=el=>{
      for(let e=el;e;e=e.parentElement){
        const c=getComputedStyle(e).backgroundColor;
        if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')return c;
      }
      return 'rgb(255,255,255)';
    };
    const labels=['h1','aside label','.mx-warning','.candidate mark','.candidate small','footer button.primary','footer .mx-note'];
    return Object.fromEntries(labels.map(sel=>{
      const el=dialog.querySelector(sel),fg=luminance(getComputedStyle(el).color),bg=luminance(background(el));
      return [sel,Number(((Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)).toFixed(2))];
    }));
  });
  assert(Object.values(report.contrast).every(ratio=>ratio>=4.5),JSON.stringify(report.contrast));
  await editor.screenshot({path:path.join(output,'workbench-1280.png')});
  await button(editor,'採用新原文').click();
  await status(editor,'此框需要重新翻譯').waitFor();
  const edited=await readCache();
  assert.equal(edited.regions.find(r=>r.id==='right').source,'新しいねこだ。');
  assert.equal(edited.regions.find(r=>r.id==='left').translation,'這是初譯。');
  await translated.fill('這是新的校正。');
  await status(editor,'校正已儲存 · 漫畫頁待更新').waitFor();
  const oldUrl=await site.locator('#page-0').getAttribute('src');
  await button(editor,'套用至漫畫頁').click();
  await status(editor,'已套用至漫畫頁').waitFor();
  assert.notEqual(await site.locator('#page-0').getAttribute('src'),oldUrl);
  assert.equal((await readCache()).regions.find(r=>r.id==='right').translation,'這是新的校正。');
  report.checks.push('啟用 → 翻譯 → 待核對框 → 另一模式比較 →採用 → 套用譯圖');

  await site.setViewportSize({width:390,height:844});
  await button(editor,'下一張').click();
  await editor.getByText('第 2／2 張',{exact:true}).waitFor();
  await editor.getByLabel('日文原文',{exact:true}).waitFor();
  assert.equal(await editor.getByRole('navigation',{name:'章節全部圖片'}).isVisible(),false);
  await menu();const importedTab=context.waitForEvent('page');
  await button(editor,'載入校正（獨立分頁）').click();
  const importer=await importedTab;
  await importer.setViewportSize({width:390,height:844});
  await importer.locator('#file').setInputFiles({name:'wrong-image.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(before))});
  await importer.getByRole('status').filter({hasText:'校正 JSON 與目前圖片不一致'}).waitFor();
  assert(await button(importer,'匯入到工作台').isDisabled());
  await importer.locator('#file').setInputFiles({name:'original-corrections.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...before,hash:hashes[1]}))});
  await importer.getByText('original-corrections.json',{exact:true}).waitFor();
  await importer.getByText('目前這張圖的全部文字框、原文、譯文及排版設定。',{exact:true}).waitFor();
  await button(importer,'匯入到工作台').click();
  await status(importer,'回到工作台按「套用至漫畫頁」').waitFor();
  await status(editor,'校正已匯入').waitFor();
  if(await button(editor,'整頁重辨識').isVisible())await menu();
  const width=await editor.evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth}));assert(width.scroll<=width.client+1,JSON.stringify(width));
  const visible=await button(editor,'套用至漫畫頁').boundingBox();assert(visible&&visible.y+visible.height<=844);
  await editor.screenshot({path:path.join(output,'workbench-390.png')});
  await button(editor,'套用至漫畫頁').click();
  await status(editor,'已套用至漫畫頁').waitFor();
  await site.keyboard.press('Escape');await editor.waitFor({state:'hidden'});
  assert.equal(await opener.evaluate(e=>e===e.getRootNode().activeElement),true);
  await importer.close();
  report.checks.push('1280/390 實際換頁、原生對話框焦點／Escape、獨立匯入及固定套用列');

  const cache=await context.newPage();await cache.goto(base+'cache.html');
  await button(cache,'清除全部頁面文字').waitFor();
  await cache.getByLabel('篩選快取來源',{exact:true}).fill('無符合頁面');
  await cache.getByText('沒有符合篩選的頁面快取。',{exact:true}).waitFor();
  assert.equal(await button(cache,'清除全部頁面文字').count(),0);
  assert.equal(await button(cache,'清除全部下載模型').count(),0);
  await button(cache,'清除篩選').click();
  await button(cache,'清除全部頁面文字').click();
  const removal=cache.getByRole('dialog',{name:'刪除 全部頁面文字與校正？'});
  await removal.getByText('這次會刪除 2 份。',{exact:false}).waitFor();
  await button(removal,'取消').click();
  assert.equal(await button(cache,'刪除此頁').count(),2);
  await button(cache,'刪除此頁').first().click();
  await cache.getByRole('dialog').getByText('這次會刪除 1 份。',{exact:false}).waitFor();
  await button(cache.getByRole('dialog'),'確認刪除').click();
  await status(cache,'已清除 1 份').waitFor();
  assert.equal(await button(cache,'刪除此頁').count(),1);
  await button(cache,'釋放閒置模型').click();
  await status(cache,'模型已從記憶體釋放。').waitFor();
  report.checks.push('篩選隱藏全清；批次與單頁刪除對話框核對類別和筆數；確認後只移除一頁');

  await options.setViewportSize({width:390,height:844});
  const manifest=await worker.evaluate(()=>chrome.runtime.getManifest().version);
  await options.getByText('墨譯 '+manifest+' · 建置',{exact:false}).waitFor();
  const save=await button(options,'儲存設定').boundingBox();assert(save&&save.y+save.height<=844);
  await sibling.bringToFront();
  const popupCreated=context.waitForEvent('page');
  await worker.evaluate(url=>chrome.tabs.create({url,active:false}),base+'popup.html');
  const popup=await popupCreated;
  await button(popup,'本機漫畫工作台').waitFor();
  await popup.getByText('本頁墨譯已啟用，可從漫畫頁開始翻譯。',{exact:true}).waitFor();
  await popup.getByText('分頁與網站權限',{exact:true}).click();
  await button(popup,'隱藏本頁工具列').click();
  await button(popup,'顯示工具列').click();
  await popup.getByText('本頁墨譯已啟用，可從漫畫頁開始翻譯。',{exact:true}).waitFor();
  reader=await context.newPage();await reader.goto(base+'reader.html');
  await button(reader,'選擇圖片').waitFor();
  assert.equal(await reader.locator('button.primary').count(),1);
  report.checks.push('設定讀套件版本及固定儲存列；彈窗依當前漫畫頁顯示狀態與工具列操作；本機空畫面檢查');
  if(process.env.COMIC_UX_ACTUAL_OCR==='1'){
    const lock=JSON.parse(await readFile(path.join(root,'src/model-lock.json'),'utf8'));
    const files=Object.values(lock.ocrProfiles.fp32).filter(value=>value&&typeof value==='object')
      .map(ref=>({url:lock.vision.find(m=>m.id===ref.model).files.find(f=>f.name===ref.file).url,file:path.join(root,'.cache/models',ref.model,ref.file)}));
    await reader.evaluate(()=>{
      const input=document.createElement('input');
      input.type='file';input.id='fixture-ocr-models';input.multiple=true;input.hidden=true;
      document.body.append(input);
    });
    const modelInput=reader.locator('#fixture-ocr-models');
    await modelInput.setInputFiles(files.map(f=>f.file));
    await modelInput.evaluate(async(input,specs)=>{
      const cache=await caches.open('comic-vision-v1');
      const selected=Array.from(input.files);
      for(const {name,url} of specs){
        const file=selected.find(value=>value.name===name);
        if(!file)throw Error('Missing local FP32 fixture: '+name);
        await cache.put(url,new Response(file));
      }
      input.remove();
    },files.map(f=>({name:path.basename(f.file),url:f.url})));
    await worker.evaluate(()=>{globalThis.ux.actualModels=true;});
    await reader.locator('input[accept="image/*"]').setInputFiles({name:'original-page.png',mimeType:'image/png',buffer:source});
    await pageInputReady(reader);
    await button(reader,'一鍵翻譯').click();
    await status(reader,/本張處理完成|部分原文需核對，其餘譯文已保留/).waitFor({timeout:120000});
    const local=await worker.evaluate(async()=>{
      const stored=await chrome.storage.local.get(null);
      return Object.values(stored).find(p=>p?.modelKey?.includes('private-reader-v1'));
    });
    assert(local.regions.some(r=>r.ocr?.profile==='int8'&&r.source.trim())&&local.regions.some(r=>r.translation.trim()));
    const ids=local.regions.find(r=>r.ocr?.profile==='int8'&&r.source.trim())?.id;
    await reader.getByLabel('選擇文字框',{exact:true}).selectOption(ids);
    await button(reader,'使用另一模式比較').click();
    await reader.getByRole('region',{name:'OCR 候選比較'}).getByText('全精度',{exact:true}).waitFor({timeout:120000});
    const compared=await worker.evaluate(async()=>{
      const stored=await chrome.storage.local.get(null);
      return Object.values(stored).find(p=>p?.modelKey?.includes('private-reader-v1'));
    });
    const candidate=compared.regions.find(r=>r.id===ids)?.ocrCandidates?.at(-1);
    assert(candidate?.source&&candidate?.profile==='fp32'&&candidate?.decoder==='kv');
    report.actualModels={detected:local.regions.length,int8:local.regions.filter(r=>r.ocr?.profile==='int8').length,comparison:{profile:candidate.profile,decoder:candidate.decoder,backend:candidate.backend},translation:'本機固定回覆'};
    report.checks.push('選擇原創圖片 → 真實 RT-DETR、INT8 MangaOCR、全精度 KV 單框比較');
  }
  report.userAgent=await site.evaluate(()=>navigator.userAgent);
  assert.deepEqual(report.errors,[]);
  report.status='passed';
}catch(error){
  report.status='failed';report.error=error.stack??String(error);process.exitCode=1;
  if(reader)report.readerMessages=await reader.locator('[role="status"], [role="alert"]').allInnerTexts().catch(()=>[]);
  if(site){
    report.shadow=await site.evaluate(()=>['[data-comic-dock]','[data-comic-studio]'].map(sel=>document.querySelector(sel)?.shadowRoot?.querySelector('.moyu')?.innerText)).catch(()=>[]);
    await site.screenshot({path:path.join(output,'failed.png')}).catch(()=>{});
  }
}finally{
  await context.close();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}

async function pageInputReady(reader){
  await reader.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='一鍵翻譯'&&!b.disabled));
}
