import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import path from 'node:path';import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {testProfile,launchTestContext,freshWorker} from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),extension=path.join(root,'.output/chrome-mv3'),out=path.join(root,'artifacts/regression-0.1.14');
await mkdir(out,{recursive:true});
const bundle=await build({stdin:{contents:"export {defaults} from './src/types';export {contentSignature} from './src/core';",resolveDir:root},bundle:true,platform:'node',format:'esm',write:false});
const {defaults,contentSignature}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const image=await readFile(path.join(root,'artifacts/corpus/pages/page-01.png'));
const images=Array.from({length:29},(_,n)=>Buffer.concat([image,Buffer.from('\noriginal-fixture-'+n)]));
const hashes=images.map(image=>createHash('sha256').update(image).digest('hex'));
const report={started:new Date().toISOString(),checks:[],errors:[],googleRequests:0,geminiPosts:0,fixtureOCR:true,fixtureTranslation:true};
const server=createServer((req,res)=>{
 const match=req.url.match(/^\/image-(\d+)\.png$/);if(match){res.setHeader('Content-Type','image/png');res.end(images[Number(match[1])]);return;}
 res.setHeader('Content-Type','text/html');res.end('<title>Original 29-page chapter fixture</title>'+images.map((_,n)=>`<img src="/image-${n}.png" width="300" height="450">`).join(''));
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://manga.test:${server.address().port}`;
let context,page,site;
try{
 context=await launchTestContext(chromium,await testProfile(root,'e2e'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--unsafely-treat-insecure-origin-as-secure=${base}`,'--host-resolver-rules=MAP manga.test 127.0.0.1, MAP gemini.google.com ~NOTFOUND','--no-proxy-server'],viewport:{width:1250,height:950}});
 await context.route('https://**/*',route=>route.abort());
 const worker=await freshWorker(context),id=worker.url().split('/')[2];page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto(`chrome-extension://${id}/options.html`);
 const config={...defaults,translationInstructions:'哥哥稱呼統一，保留喜劇語氣'},modelKey=contentSignature(config);
 await page.evaluate(async({config,modelKey,hashes,base})=>{
   const data={settings:config,geminiValidation:{status:'passed',completed:30,fixture:true},pageKeys:[]};
   hashes.forEach((hash,n)=>{const key=`page:${hash}:${modelKey}`;data.pageKeys.push(key);data[key]={schema:1,hash,width:1000,height:1500,modelKey,title:'',chapter:'',glossary:'',summary:'',imageUrl:`${base}/image-${n}.png`,regions:[{id:'same-id',x:100,y:100,width:100,height:130,order:0,source:`お兄ちゃん、待って！${n}`,translation:'舊的 Google 初譯',ocrDone:true,score:1,kind:'bubble',render:'overlay',warnings:[]}]};});
   await chrome.storage.local.set(data);
 },{config,modelKey,hashes,base});
 await page.reload();await page.getByLabel('整章翻譯模式',{exact:true}).selectOption('gemini-direct');await page.getByRole('button',{name:'儲存設定',exact:true}).click();await page.getByRole('status').filter({hasText:'設定已儲存'}).waitFor();
 // Offscreen documents are CDP "other" targets and are outside Playwright's
 // page routing. Install a fixture transport on that exact isolated target.
 await page.evaluate(()=>chrome.runtime.sendMessage({channel:'native-status'}));
 const cdp=await context.browser().newBrowserCDPSession(),targets=await cdp.send('Target.getTargets'),target=targets.targetInfos.find(t=>t.url===`chrome-extension://${id}/offscreen.html`);assert(target);
 const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});let sequence=0;
 const evaluate=expression=>new Promise((resolve,reject)=>{const command=++sequence;const receive=event=>{if(event.sessionId!==sessionId)return;const response=JSON.parse(event.message);if(response.id!==command)return;cdp.off('Target.receivedMessageFromTarget',receive);if(response.error||response.result?.exceptionDetails)reject(Error(JSON.stringify(response)));else resolve(response.result.result.value);};cdp.on('Target.receivedMessageFromTarget',receive);cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:command,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}})}).catch(reject);});
 await evaluate(`(${function(){
   const original=globalThis.fetch;globalThis.fixtureGemini={posts:0,errors:[]};
   globalThis.fetch=async(input,init)=>{
     if(new URL(String(input)).hostname!=='gemini.google.com')return original(input,init);
     if(init?.method!=='POST')return new Response('boq_gemini-web-uiserver_20261015.01_p0');
     const stats=globalThis.fixtureGemini;stats.posts++;
     const inner=JSON.parse(JSON.parse(new URLSearchParams(init.body).get('f.req'))[1]),prompt=inner[0][0],data=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
     if(data.pages.length!==29||data.translationInstructions!=='哥哥稱呼統一，保留喜劇語氣'||data.pages.some(p=>p.regions.some(r=>'draft' in r||'current' in r)))stats.errors.push('invalid full chapter input');
     const text=JSON.stringify(data.pages.flatMap(p=>p.regions.filter(r=>!r.reviewOnly).map(r=>({id:r.id,text:`第 ${p.page} 頁直譯`}))).reverse());
     return new Response(")]}'\n\n123\n"+JSON.stringify([['wrb.fr','rpc',JSON.stringify([null,null,null,null,[['candidate',[text]]]])]])+'\n');
   };
 }.toString()})()`);
 await worker.evaluate(()=>{const original=globalThis.fetch;globalThis.fixtureGoogleRequests=0;globalThis.fetch=async(input,init)=>{if(/translate/.test(new URL(String(input)).hostname)){globalThis.fixtureGoogleRequests++;throw Error('unexpected Google request');}return original(input,init);};});
 site=await context.newPage();site.on('pageerror',e=>report.errors.push(String(e)));await site.goto(base);await site.waitForFunction(()=>[...document.images].every(i=>i.complete));
 const tabs=await worker.evaluate(()=>chrome.tabs.query({})),tab=tabs.find(t=>t.url?.startsWith(base));assert(tab);
 assert.equal((await page.evaluate(tabId=>chrome.runtime.sendMessage({channel:'activate-page',tabId}),tab.id)).ok,true);
 await site.getByLabel('整章翻譯模式',{exact:true}).selectOption('gemini-direct');await site.getByRole('button',{name:'翻譯本頁漫畫',exact:true}).click();
 await site.getByRole('status').filter({hasText:'整章 Gemini 直譯完成'}).waitFor({timeout:60000});
 await site.getByRole('status').filter({hasText:'已呈現 29/29 張'}).waitFor();
 assert.equal(await site.evaluate(()=>[...document.images].filter(i=>i.dataset.comicResult).length),29);
 const saved=await page.evaluate(async()=>{const {pageKeys}=await chrome.storage.local.get('pageKeys');const data=await chrome.storage.local.get(pageKeys);return pageKeys.map(k=>data[k]);});
 assert.equal(saved.filter(p=>p.refinement?.mode==='direct').length,29);
 for(let n=0;n<29;n++){const p=saved.find(p=>p.hash===hashes[n]&&p.refinement?.mode==='direct');assert.equal(p.regions[0].translation,`第 ${n+1} 頁直譯`);assert.equal(p.regions[0].initialTranslation,undefined);}
 report.googleRequests=await worker.evaluate(()=>globalThis.fixtureGoogleRequests);const stats=await evaluate('globalThis.fixtureGemini');report.geminiPosts=stats.posts;assert.deepEqual(stats.errors,[]);assert.equal(report.googleRequests,0);assert.equal(report.geminiPosts,1);
 report.checks.push('29-page UI workflow reuses all cached Google OCR despite 30-entry rotation, issues zero Google requests and one anonymous Gemini fixture POST, validates reverse-ordered IDs and applies all 29 PNGs');
 await site.getByRole('button',{name:'翻譯本頁漫畫',exact:true}).click();await site.getByRole('status').filter({hasText:'沿用已存結果'}).waitFor({timeout:60000});assert.equal((await evaluate('globalThis.fixtureGemini')).posts,1);
 report.checks.push('unchanged chapter rerun reuses validated direct translations with no additional Gemini request');
 await site.getByRole('button',{name:'章節工作台',exact:true}).click();await site.getByRole('button',{name:'選取文字框 1',exact:true}).click();
 assert.equal(await site.getByLabel('繁中譯文',{exact:true}).inputValue(),'第 1 頁直譯');
 await site.getByLabel('繁中譯文',{exact:true}).fill('人工修正的整章直譯');await site.getByRole('button',{name:'套用至漫畫頁',exact:true}).click();
 await site.getByText('已套用至漫畫頁',{exact:false}).waitFor();
 const edited=await page.evaluate(async hash=>{const {pageKeys}=await chrome.storage.local.get('pageKeys');const values=await chrome.storage.local.get(pageKeys);return pageKeys.map(k=>values[k]).find(p=>p.hash===hash&&p.refinement?.mode==='direct');},hashes[0]);
 assert.equal(edited.regions[0].translation,'人工修正的整章直譯');report.checks.push('chapter studio restores direct translations and saves manual corrections to the direct cache');
 await site.getByRole('button',{name:'關閉工作台',exact:true}).click();
 assert.equal(report.errors.length,0);await site.getByRole('region',{name:'墨譯章節翻譯'}).screenshot({path:path.join(out,'direct-mode.png')});report.status='passed';
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;if(site){report.dock=await site.evaluate(()=>document.querySelector('[data-comic-dock]')?.shadowRoot?.textContent).catch(()=>null);report.body=await site.locator('body').innerText({timeout:2000}).catch(()=>null);await site.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}}
finally{await context?.close();await new Promise(resolve=>server.close(resolve));report.finished=new Date().toISOString();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
