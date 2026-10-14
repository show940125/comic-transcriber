import {chromium} from 'playwright';import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';import {testProfile,freshWorker} from './harness.mjs';
import {createServer} from 'node:http';
const root=fileURLToPath(new URL('../',import.meta.url)),ext=path.join(root,'.output/chrome-mv3');
const context=await chromium.launchPersistentContext(await testProfile(root,'no-gpu'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--disable-gpu','--disable-software-rasterizer','--disable-features=WebGPU']});
const result={};
const server=createServer(async(q,r)=>{r.setHeader('Access-Control-Allow-Origin','*');r.setHeader('Access-Control-Allow-Headers','Content-Type');if(q.method==='OPTIONS'){r.end();return;}const parts=[];for await(const p of q)parts.push(p);const body=JSON.parse(Buffer.concat(parts)),rows=JSON.parse(body.messages.at(-1).content).dialogue;r.setHeader('Content-Type','application/json');r.end(JSON.stringify({choices:[{message:{content:JSON.stringify(rows.map(row=>({id:row.id,text:'你好'})))}}],backend:'fixture-only'}));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
try{
 const worker=await freshWorker(context),id=worker.url().split('/')[2],page=await context.newPage();await page.goto(`chrome-extension://${id}/reader.html`);await page.waitForLoadState('networkidle');
 result.gpu=await page.evaluate(async()=>{const r=await chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'probe'}});return r.result;});
 const manifest=JSON.parse(await readFile(path.join(root,'artifacts/corpus/manifest.json'),'utf8')),bytes=[...await readFile(path.join(root,'artifacts/corpus/pages/page-01.png'))];
 await context.setOffline(true);
 const response=await page.evaluate(async({bytes,region})=>await chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'ocr',image:bytes,mime:'image/png',regions:[region],provider:'wasm'}}),{bytes,region:manifest.pages[0].regions[0]});
 assert(response.ok,response.error);assert.equal(response.result[0].source,manifest.pages[0].regions[0].source);result.ocr=response.result;
 const unsupported=await page.evaluate(async()=>await chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'translate',regions:[{id:'x',source:'こんにちは',translation:'',order:0}],settings:{backend:'webllm'},modelId:'Qwen3.5-0.8B-q4f16_1-MLC'}}));
 result.translation=unsupported;
 await context.setOffline(false);
 const fallback=await page.evaluate(async port=>await chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'translate',regions:[{id:'x',source:'こんにちは',translation:'',order:0}],settings:{backend:'webllm',localFallback:true,endpoint:`http://127.0.0.1:${port}/v1`,localModel:'fixture',title:'',chapter:'',glossary:'',priorSummary:''},modelId:'Qwen3.5-0.8B-q4f16_1-MLC'}}),port);
 assert(fallback.ok,fallback.error);assert.equal(fallback.result[0].translation,'你好');result.optInFallback={ok:true,fixtureOnly:true};
 if(!result.gpu.available){assert(!unsupported.ok);result.status='passed-no-gpu';}else result.status='passed-wasm-only; Chromium flag did not remove adapter';
}catch(error){result.status='failed';result.error=String(error);process.exitCode=1;}finally{await context.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(root,'artifacts/no-gpu.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
