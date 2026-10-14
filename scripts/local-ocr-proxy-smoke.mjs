import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {freshWorker,testProfile} from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),input=await readFile(path.join(root,'artifacts/corpus/pages/page-01.png'));
const report={scope:'real extension Worker-to-loopback HTTP; OCR output fixture, not model quality',status:'pending',calls:0};
const server=createServer(async(req,res)=>{res.setHeader('Access-Control-Allow-Origin',req.headers.origin??'*');res.setHeader('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));assert.equal(Buffer.from(body.image,'base64').length,input.length);assert.equal(req.url,'/ocr');report.calls++;report.origin=req.headers.origin??null;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({backend:'fixture-only',regions:body.regions.map(r=>({...r,source:'テスト'}))}));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let context;
try{
 const extension=path.join(root,'.output/chrome-mv3');context=await chromium.launchPersistentContext(await testProfile(root,'local-ocr-proxy'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});const worker=await freshWorker(context);
 const page=await context.newPage();await page.goto(`chrome-extension://${worker.url().split('/')[2]}/reader.html`);await page.waitForLoadState('networkidle');
 const request={op:'local-ocr',image:input.toString('base64'),mime:'image/png',regions:[{id:'proxy-1',x:0,y:0,width:100,height:100,source:'',translation:'',order:0,score:1,warnings:[],kind:'bubble',render:'auto'}],endpoint:`http://127.0.0.1:${server.address().port}`};
 const response=await page.evaluate(request=>chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request}),request);assert(response.ok,response.error);assert.equal(response.result.regions[0].source,'テスト');assert.equal(response.result.backend,'fixture-only');
 const rejected=await page.evaluate(request=>chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request}),{...request,endpoint:'https://example.com'});assert.equal(rejected.ok,false);assert.match(rejected.error,/localhost/);assert.equal(report.calls,1);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);process.exitCode=1;}finally{await context?.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(root,'artifacts/local-ocr-proxy-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
