import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import path from 'node:path';import assert from 'node:assert/strict';
import {testProfile,launchTestContext,freshWorker} from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),extension=path.join(root,'.output/chrome-mv3'),out=path.join(root,'artifacts/regression-0.1.12');
await mkdir(out,{recursive:true});
const report={started:new Date().toISOString(),checks:[],errors:[],remoteRequests:[],fixtureTranslationOnly:true};
const instructions='本作是奇幻喜劇；主角語氣直率，長老使用正式語氣，兄さん統一為「哥哥」。';
let fixtureCalls=0;
const server=createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');
 if(req.method==='OPTIONS'){res.end();return;}
 try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));const input=JSON.parse(body.messages.at(-1).content);assert.equal(input.translationInstructions,instructions);fixtureCalls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(input.dialogue.map(r=>({id:r.id,text:'哥哥，等等！'})))}}]}));}
 catch(error){res.statusCode=500;res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let context,page;
try{
 context=await launchTestContext(chromium,await testProfile(root,'e2e'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1200,height:1000}});
 context.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith('http://127.0.0.1:'))report.remoteRequests.push(new URL(request.url()).origin);});
 await context.route('https://**/*',route=>route.abort());
 const worker=await freshWorker(context),id=worker.url().split('/')[2];
 page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto(`chrome-extension://${id}/options.html`);
 await page.getByLabel('漫畫專屬翻譯指示',{exact:true}).fill(instructions);
 await page.getByRole('button',{name:'儲存設定',exact:true}).click();await page.getByRole('status').filter({hasText:'設定已儲存'}).waitFor();
 await page.reload();assert.equal(await page.getByLabel('漫畫專屬翻譯指示',{exact:true}).inputValue(),instructions);
 await page.getByLabel('漫畫專屬翻譯指示',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'translation-instructions.png')});report.checks.push('new instruction field saves and restores through actual settings UI');
 for(let cycle=0;cycle<5;cycle++){
  const results=await page.evaluate(async()=>Promise.all([0,1].map(()=>chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'runtime-info'}}))));
  assert(results.every(r=>r.ok&&r.result.models===0),JSON.stringify(results));
  const released=await page.evaluate(()=>chrome.runtime.sendMessage({channel:'runtime-release'}));assert.equal(released.released,true);
  const status=await page.evaluate(()=>chrome.runtime.sendMessage({channel:'runtime-status'}));assert.equal(status.result.phase,'released');assert.equal(status.result.worker,false);
 }
 report.checks.push('five cold/released cycles: two concurrent engine jobs succeed on first submission, no models or GPU loaded');
 await page.evaluate(async({endpoint,instructions})=>{const {settings={}}=await chrome.storage.local.get('settings');await chrome.storage.local.set({settings:{...settings,backend:'local',endpoint,localModel:'fixture',ocrProvider:'wasm',wasmThreads:1,translationInstructions:instructions}});},{endpoint:`http://127.0.0.1:${server.address().port}/v1`,instructions});
 const image=await readFile(path.join(root,'artifacts/corpus/pages/page-01.png')),manifest=JSON.parse(await readFile(path.join(root,'artifacts/corpus/manifest.json'),'utf8'));
 const correction={schema:1,hash:createHash('sha256').update(image).digest('hex'),width:1000,height:1500,regions:[{...manifest.pages[0].regions[0],source:'',translation:'',ocrDone:false,render:'auto',warnings:[]}]};
 await page.goto(`chrome-extension://${id}/reader.html`);await page.locator('input[accept="image/*"]').setInputFiles(path.join(root,'artifacts/corpus/pages/page-01.png'));
 await page.waitForFunction(()=>{const input=document.querySelector('input[aria-label="載入校正 JSON"]');return input&&!input.disabled;});
 await page.getByLabel('載入校正 JSON').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(correction))});
 await page.waitForFunction(()=>document.body.innerText.includes('校正已載入'));
 await page.getByRole('button',{name:'一鍵翻譯',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.status')?.textContent.includes('本張處理完成'),undefined,{timeout:180000});
 assert.equal(await page.getByLabel('繁中譯文').inputValue(),'哥哥，等等！');assert.equal(fixtureCalls,1);
 assert(/[\u3040-\u30ff\u4e00-\u9fff]/.test(await page.getByLabel('日文原文').inputValue()));
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'匯出 PNG',exact:true}).click()]);await download.saveAs(path.join(out,'synthetic-result.png'));
 report.checks.push('first one-click pass completes real offline WASM Manga-OCR, custom instructions in local fixture request, typesetting and PNG export');
 assert.equal(report.remoteRequests.length,0);assert.equal(report.errors.length,0);report.status='passed';
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;if(page){report.body=await page.locator('body').innerText({timeout:2000}).catch(()=>null);await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}}
finally{await context?.close();await new Promise(resolve=>server.close(resolve));report.finished=new Date().toISOString();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
