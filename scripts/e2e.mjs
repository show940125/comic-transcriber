import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { freshWorker, launchTestContext,testProfile } from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const report={started:new Date().toISOString(),checks:[],errors:[],network:[],gpu:null};
await mkdir(path.join(root,'artifacts/e2e'),{recursive:true});
const fixture=await readFile(path.join(root,'artifacts/corpus/pages/page-01.png'));
const imageData='data:image/png;base64,'+fixture.toString('base64');
const manifest=JSON.parse(await readFile(path.join(root,'artifacts/corpus/manifest.json'),'utf8'));
let fixtureCalls=0;
const server=createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.end();return;}
  if(req.url==='/v1/chat/completions'){
    const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));
    const group=JSON.parse(body.messages.at(-1).content).dialogue;fixtureCalls++;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(group.map(r=>({id:r.id,text:'今天天氣真好。'})))}}]}));return;
  }
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><body style="margin:0"><img id="comic" src="${imageData}" width="600"><div style="height:1200px"></div><img id="lazy" loading="lazy" src="${imageData}" width="600"></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,extension=path.resolve(root,process.env.COMIC_BUILD_DIR??'.output/chrome-mv3');
let context, page;
try{
  context=await launchTestContext(chromium,await testProfile(root,'e2e'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1440,height:1000}});
  const worker=await freshWorker(context);
  const id=worker.url().split('/')[2],url=`chrome-extension://${id}`;
  page=await context.newPage();page.on('pageerror',error=>report.errors.push(String(error)));
  context.on('request',r=>{if(/^https?:/.test(r.url()))report.network.push({url:r.url(),method:r.method()});});
  await page.goto(`${url}/reader.html`);await page.waitForLoadState('networkidle');
  await page.evaluate(()=>chrome.storage.local.set({settings:{wasmThreads:1}}));
  report.gpu=await page.evaluate(async()=>{const response=await chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'probe'}});return response.result;});
  const lock=JSON.parse(await readFile(path.join(root,'src/model-lock.json'),'utf8'));
  const detector=lock.vision.find(m=>m.id==='detector').files.map(({name})=>({model:'detector',file:name}));
  const refs=[...detector,...Object.values(lock.ocrProfiles.int8).filter(value=>value&&typeof value==='object')];
  const files=refs.map(({model,file})=>({file:`/models/${model}/${file}`,url:lock.vision.find(m=>m.id===model).files.find(f=>f.name===file).url}));
  await page.evaluate(async files=>{
    const cache=await caches.open('comic-vision-v1');
    for(const {file,url} of files){
      const response=await fetch(chrome.runtime.getURL(file));
      if(!response.ok)throw Error('Offline model not staged: '+file);
      await cache.put(url,response);
    }
  },files);
  await context.route('https://**/*',route=>route.abort());
  await context.setOffline(true);
  const imageInput=page.locator('input[accept="image/*"]'),imagePath=path.join(root,'artifacts/corpus/pages/page-01.png');
  await imageInput.setInputFiles(imagePath);
  await page.locator('canvas').waitFor();
  await page.getByText('本頁執行紀錄',{exact:true}).click();
  await page.getByText('繁中字型就緒',{exact:false}).waitFor();
  report.checks.push('unpacked MV3 load, offscreen worker probe and bundled Traditional Chinese font');
  const tools=page.getByText('頁面工具',{exact:true});
  await tools.click();
  await page.getByRole('button',{name:'偵測文字框',exact:true}).click();
  await page.getByRole('status').filter({hasText:'已重新偵測'}).waitFor({timeout:120000});
  await page.waitForFunction(()=>document.querySelectorAll('.regions button').length>=8,{},{timeout:120000});
  const detected=await page.locator('.regions button').count();assert(detected>=8,`Expected bubbles; got ${detected}`);
  report.checks.push(`real detector execution offline (${detected} regions)`);
  await page.getByRole('button',{name:'辨識日文',exact:true}).click();
  await page.getByRole('dialog',{name:'重辨識整張圖片？'}).getByRole('button',{name:'確認重辨識'}).click();
  await page.getByRole('status').filter({hasText:'已重新辨識'}).waitFor({timeout:300000});
  await tools.click();
  const source=await page.getByRole('textbox',{name:'日文原文'}).inputValue();assert(/[\u3040-\u30ff\u4e00-\u9fff]/.test(source));assert(!source.includes('[CLS]'));
  report.checks.push('real Manga-OCR execution offline, special-token cleanup');
  const cpuStart=performance.now();
  const cpuResult=await page.evaluate(({region,image})=>chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'ocr',provider:'wasm',regions:[region],image,mime:'image/png'}}),{region:manifest.pages[0].regions[0],image:fixture.toString('base64')});
  assert(cpuResult.ok,cpuResult.error);assert.equal(cpuResult.result[0].source,manifest.pages[0].regions[0].source);report.wasmOneRegionMs=performance.now()-cpuStart;report.checks.push('explicit single-thread WASM OCR executes offline');
  const runtime=await page.evaluate(()=>chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'runtime-info'}}));
  assert.equal(runtime.result.effectiveThreads,1);
  await context.setOffline(false);
  await page.getByRole('textbox',{name:'繁中譯文'}).fill('今天天氣真好。');
  // The renderer can use the entire bubble for Chinese lettering. Compare
  // against the first bubble drawn by make-corpus.py, not the smaller OCR box.
  const bubble={left:650,top:65,right:930,bottom:240};
  await page.getByRole('button',{name:'原圖',exact:true}).click();
  const raw=await page.evaluate(()=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(0,0,1000,1500).data));
  await page.getByRole('button',{name:'譯圖',exact:true}).click();
  const painted=await page.evaluate(()=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(0,0,1000,1500).data));
  let changed=0,outside=0;for(let y=0;y<1500;y++)for(let x=0;x<1000;x++){const i=(y*1000+x)*4;if(raw[i]!==painted[i]||raw[i+1]!==painted[i+1]||raw[i+2]!==painted[i+2]){changed++;if(x<bubble.left||x>bubble.right||y<bubble.top||y>bubble.bottom)outside++;}}
  assert(changed>30);assert.equal(outside,0);report.checks.push(`nonblank Chinese typesetting, original toggle and exterior preservation of the authored bubble (${changed} changed pixels)`);
  await page.getByText('匯出',{exact:true}).click();
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'匯出 PNG'}).click()]);await download.saveAs(path.join(root,'artifacts/e2e/translated.png'));
  const [jsonDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'匯出校正 JSON'}).click()]);await jsonDownload.saveAs(path.join(root,'artifacts/e2e/correction.json'));
  await page.getByText('匯出',{exact:true}).click();
  const corrected=JSON.parse(await readFile(path.join(root,'artifacts/e2e/correction.json'),'utf8'));assert.equal(corrected.regions.length,detected);
  report.checks.push('PNG and correction JSON export');
  await page.screenshot({path:path.join(root,'artifacts/e2e/reader-desktop.png'),fullPage:true});
  await page.setViewportSize({width:600,height:900});await page.screenshot({path:path.join(root,'artifacts/e2e/reader-narrow.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  // Fixture transport tests the real local API routing, without claiming model quality.
  const translated=await page.evaluate(async({regions,port})=>{const s={backend:'local',model:'0.8b',endpoint:`http://127.0.0.1:${port}/v1`,localModel:'fixture',localOcr:false,ocrEndpoint:'http://127.0.0.1:8766',auto:false,title:'fixture',chapter:'1',glossary:'',priorSummary:''};return chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'translate',regions,settings:s,modelId:'fixture'}});},{regions:corrected.regions,port});assert(translated.ok,translated.error);assert(translated.result.every(r=>!r.source||r.translation));assert(fixtureCalls>0);report.checks.push('local API transport and ID mapping (fixture, not translation quality)');
  await page.reload();await page.waitForLoadState('networkidle');await imageInput.setInputFiles(imagePath);await page.getByRole('status').filter({hasText:'已載入這張圖的上次校正'}).waitFor();report.checks.push('image-hash/context cache restore');
  const broken=await page.evaluate(async()=>{const cache=await caches.open('comic-vision-v1');await cache.put('https://invalid.test/model',new Response('broken'));return true;});assert(broken);
  await page.goto(`${url}/options.html`);await page.waitForLoadState('networkidle');await page.screenshot({path:path.join(root,'artifacts/e2e/options.png'),fullPage:true});
  const site=await context.newPage();await site.goto(`http://127.0.0.1:${port}/`);await site.waitForLoadState('networkidle');
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,site.url());
  const activation=await page.evaluate(tabId=>chrome.runtime.sendMessage({channel:'activate-page',tabId}),tabId);
  assert(activation.ok,activation.error);
  await site.getByRole('button',{name:'章節工作台',exact:true}).click();
  const frame=site.getByRole('dialog',{name:'章節工作台',exact:true});
  await frame.getByRole('button',{name:'套用至漫畫頁'}).click();
  await site.waitForFunction(()=>document.querySelector('#comic').dataset.comicResult);report.checks.push('content-script image handoff, Shadow DOM editor and in-page result');
  report.status='passed';report.fixtureTranslationOnly=true;
}catch(error){report.status='failed';report.failure=String(error);process.exitCode=1;console.error(error);if(page){report.body=await page.locator('body').innerText({timeout:2000}).catch(()=>null);await page.screenshot({path:path.join(root,'artifacts/e2e/failure.png'),fullPage:true}).catch(()=>{});}report.frames=[];for(const p of context?.pages()??[])for(const f of p.frames()){report.frames.push({url:f.url(),body:await f.locator('body').innerText({timeout:2000}).catch(()=>null)});}}
finally{await context?.close();await new Promise(resolve=>server.close(resolve));report.finished=new Date().toISOString();await writeFile(path.join(root,'artifacts/e2e/report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks,gpu:report.gpu,failure:report.failure},null,2));}
