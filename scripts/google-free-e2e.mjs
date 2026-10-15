import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launchTestContext,testProfile, freshWorker } from './harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), ext = path.join(root, '.output/chrome-mv3');
const report = { schema:1, checkedAt:new Date().toISOString(), network:[], billing:'no key or billing account used', source:'original synthetic page-01; GT coordinates to isolate translation', checks:[] };
const manifest = JSON.parse(await readFile(path.join(root, 'artifacts/corpus/manifest.json'), 'utf8'));
const bytes = await readFile(path.join(root, 'artifacts/corpus/pages/page-01.png'));
const correction = { schema:1,hash:createHash('sha256').update(bytes).digest('hex'),width:1000,height:1500,regions:manifest.pages[0].regions.map(r=>({...r,translation:'',render:'auto',warnings:[]})) };
let context;
try {
 context = await launchTestContext(chromium,await testProfile(root, 'google-free'), { channel:'chromium',headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`],viewport:{width:1440,height:1000} });
 const worker=await freshWorker(context),id=worker.url().split('/')[2],page=await context.newPage();
 await page.goto(`chrome-extension://${id}/options.html`);await page.waitForLoadState('networkidle');
 await page.getByLabel('執行方式').selectOption('google-web');await page.getByRole('button',{name:'儲存設定',exact:true}).click();await page.getByRole('status').filter({hasText:'設定已儲存'}).waitFor();
 assert(await page.evaluate(()=>chrome.permissions.contains({origins:['https://translate.googleapis.com/*']})));
 await page.goto(`chrome-extension://${id}/reader.html`);await page.waitForLoadState('networkidle');
 await page.locator('input[accept="image/*"]').setInputFiles(path.join(root,'artifacts/corpus/pages/page-01.png'));
 await page.getByRole('button',{name:'1 偵測文字框'}).waitFor();await page.waitForFunction(()=>!document.querySelector('input[aria-label="載入校正 JSON"]').disabled);
 await page.getByLabel('載入校正 JSON').setInputFiles({name:'page-01.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(correction))});
 await page.waitForFunction(()=>document.querySelector('.status')?.textContent.includes('校正已載入'));assert.equal(await page.locator('.regions button').count(),10);report.checks.push('hash-bound correction JSON import and Google provider opt-in');
 context.on('request',request=>{if(/^https?:/.test(request.url()))report.network.push({url:request.url(),method:request.method(),body:request.postData()});});
 const started=performance.now();await page.getByRole('button',{name:'3 翻譯繁中'}).click();await page.waitForFunction(()=>document.querySelector('.status')?.textContent.includes('Google 網頁翻譯完成'),undefined,{timeout:180000});report.pageMs=performance.now()-started;
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'匯出校正 JSON'}).click()]);
 await mkdir(path.join(root,'artifacts/google-free'),{recursive:true});await download.saveAs(path.join(root,'artifacts/google-free/correction.json'));
 const output=JSON.parse(await readFile(path.join(root,'artifacts/google-free/correction.json'),'utf8'));assert(output.regions.every(r=>r.translation));report.rows=output.regions.map(({id,source,translation})=>({id,source,translation}));
 assert(report.network.length>0);assert(report.network.every(r=>r.url.startsWith('https://translate.googleapis.com/translate_a/single?')&&r.method==='GET'&&r.body===null));report.checks.push('real anonymous Google web translation, exact region IDs, text-only requests and PNG typesetting');
 const [png]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'匯出 PNG'}).click()]);await png.saveAs(path.join(root,'artifacts/google-free/translated.png'));await page.screenshot({path:path.join(root,'artifacts/google-free/reader.png'),fullPage:true});
 // Built-in API requires user activation for the first model download.
 report.builtin=await page.evaluate(async()=>({exposed:'Translator' in self,availability:'Translator' in self?await Translator.availability({sourceLanguage:'ja',targetLanguage:'zh-Hant'}):'API absent'}));
 if(process.env.PROBE_BUILTIN==='1'&&report.builtin.availability!=='unavailable'&&report.builtin.exposed){
   await page.evaluate(()=>{
     const button=document.createElement('button');button.id='probe-translator';button.textContent='測試本機翻譯';document.body.append(button);
     window.__builtinProgress=[];
     button.onclick=async()=>{const start=performance.now();let translator;try{translator=await Translator.create({sourceLanguage:'ja',targetLanguage:'zh-Hant',monitor(m){m.addEventListener('downloadprogress',e=>window.__builtinProgress.push(e.loaded));}});window.__builtinResult={ok:true,text:await translator.translate('一緒に帰ろう。'),ms:performance.now()-start};}catch(error){window.__builtinResult={ok:false,error:String(error),ms:performance.now()-start};}finally{translator?.destroy();}};
   });
   await page.locator('#probe-translator').click();await page.waitForFunction(()=>window.__builtinResult,undefined,{timeout:600000});
   Object.assign(report.builtin,await page.evaluate(()=>({...window.__builtinResult,downloadProgress:window.__builtinProgress})));console.log('Built-in translator:',JSON.stringify(report.builtin));
 }
 report.status='passed-google-web; builtin availability reported separately';
} catch(error){report.status='failed';report.error=String(error);report.pages=await Promise.all((context?.pages()??[]).map(async page=>({url:page.url(),body:await page.locator('body').innerText().catch(()=>null)})));process.exitCode=1;}
finally{await context?.close();await writeFile(path.join(root,'artifacts/google-free-e2e.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,pageMs:report.pageMs,requests:report.network.length,builtin:report.builtin,error:report.error},null,2));}
