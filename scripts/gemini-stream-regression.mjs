// Isolated extension transport regression. All Gemini responses are original
// fixtures; no request reaches Gemini or the user's browser/profile.
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';import assert from 'node:assert/strict';
import {testProfile,launchTestContext,freshWorker} from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),channel=process.argv[2]??'chromium';
if(!['chromium','msedge'].includes(channel))throw Error('Expected chromium or msedge');
const out=path.join(root,'artifacts/gemini-size-limit');await mkdir(out,{recursive:true});
const report={channel,started:new Date().toISOString(),scope:'19-page original fixture; real extension background/offscreen/storage; mocked network',checks:[],errors:[]};
let context,page;
try{
 context=await launchTestContext(chromium,await testProfile(root,'e2e'),{channel,headless:true,args:[`--disable-extensions-except=${path.join(root,'.output/chrome-mv3')}`,`--load-extension=${path.join(root,'.output/chrome-mv3')}`,'--host-resolver-rules=MAP gemini.google.com ~NOTFOUND','--no-proxy-server'],viewport:{width:1250,height:950}});
 await context.route('https://**/*',route=>route.abort());
 const worker=await freshWorker(context),id=worker.url().split('/')[2];page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto(`chrome-extension://${id}/options.html`);
 report.version=await page.evaluate(()=>chrome.runtime.getManifest().version);
 await page.evaluate(()=>chrome.storage.local.set({geminiValidation:{status:'blocked',completed:0,error:'GeminiFailure: Gemini 回覆超過大小限制'},geminiValidationProgress:{completed:30,total:30}}));
 assert.equal((await page.evaluate(()=>chrome.runtime.sendMessage({channel:'gemini-status'}))).result.protocolPassed,true);
 await page.evaluate(()=>chrome.runtime.sendMessage({channel:'native-status'}));
 const cdp=await context.browser().newBrowserCDPSession(),targets=await cdp.send('Target.getTargets'),target=targets.targetInfos.find(t=>t.url===`chrome-extension://${id}/offscreen.html`);assert(target);
 const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});let sequence=0;
 const evaluate=expression=>new Promise((resolve,reject)=>{const command=++sequence;const receive=event=>{if(event.sessionId!==sessionId)return;const response=JSON.parse(event.message);if(response.id!==command)return;cdp.off('Target.receivedMessageFromTarget',receive);if(response.error||response.result?.exceptionDetails)reject(Error(JSON.stringify(response)));else resolve(response.result.result.value);};cdp.on('Target.receivedMessageFromTarget',receive);cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:command,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}})}).catch(reject);});
 await evaluate(`(${function(){
  const original=globalThis.fetch;globalThis.streamFixture={posts:0,cancelled:0,mode:'normal'};
  globalThis.fetch=async(input,init)=>{
   if(new URL(String(input)).hostname!=='gemini.google.com')return original(input,init);
   if(init?.method!=='POST')return new Response('boq_gemini-web-uiserver_20261013.29_p0');
   const stats=globalThis.streamFixture;stats.posts++;
   const prompt=JSON.parse(JSON.parse(new URLSearchParams(init.body).get('f.req'))[1])[0][0],data=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
   const text=JSON.stringify(data.pages.flatMap(p=>p.regions.filter(r=>!r.reviewOnly).map(r=>({id:r.id,text:`校訂第${p.page}頁：${r.source.repeat(4)}`}))).reverse());
   const frame=t=>JSON.stringify([['wrb.fr','rpc',JSON.stringify([null,null,null,null,[['candidate',[t]]]])]])+'\n';
   const raw=stats.mode==='limit'?frame('字'.repeat(2_000_001)):")]}'\n\n"+Array.from({length:320},(_,n)=>frame(text.slice(0,Math.ceil(text.length*(n+1)/320)))).join('');
   const bytes=new TextEncoder().encode(raw);let offset=0;
   return new Response(new ReadableStream({pull(c){if(offset===bytes.length){if(stats.mode!=='limit')c.close();return;}const end=Math.min(offset+8191,bytes.length);c.enqueue(bytes.subarray(offset,end));offset=end;},cancel(){stats.cancelled++;}}));
  };
 }.toString()})()`);
 const pages=Array.from({length:19},(_,n)=>({schema:1,hash:`original-${n}`,width:1000,height:1500,title:'',chapter:'',glossary:'',summary:'',modelKey:'fixture',regions:Array.from({length:12},(_,i)=>({id:`r${i}`,x:10,y:10,width:100,height:100,order:i,source:`これは第${n+1}頁の原創テスト対話です。`,translation:'原有初譯',score:1,warnings:[],kind:'bubble',render:'overlay',ocrDone:true}))}));
 const settings={title:'',chapter:'',glossary:'',priorSummary:'',translationInstructions:''};
 const invoke=channel=>page.evaluate(({channel,pages,settings})=>chrome.runtime.sendMessage({channel,id:crypto.randomUUID(),pages,settings}),{channel,pages,settings});
 for(const mode of ['gemini-refine','gemini-chapter']){
  const reply=await invoke(mode);assert.equal(reply.ok,true,reply.error);assert.equal(reply.result.pages.length,19);assert.equal(reply.result.regions,228);
  assert(reply.result.pages.every(p=>p.regions.every(r=>r.translation.startsWith('校訂第'))));
  if(mode==='gemini-refine')assert(reply.result.pages.every(p=>p.regions.every(r=>r.initialTranslation==='原有初譯')));
  const {geminiJobs,geminiUnknown}=await page.evaluate(()=>chrome.storage.local.get(['geminiJobs','geminiUnknown'])),job=geminiJobs[0];
  assert.equal(job.status,'complete');assert.equal(job.diagnostic.frames,320);assert(job.diagnostic.receivedCharacters>2_000_000);assert.equal(job.raw.length,24000);assert.equal(job.rawTruncated,true);assert.equal(Object.keys(geminiUnknown).length,0);
  report.checks.push({mode,pages:19,regions:228,diagnostic:job.diagnostic});
 }
 await page.reload();await page.getByText('匿名協定診斷',{exact:true}).click();await page.getByText('串流累計',{exact:false}).waitFor();await page.screenshot({path:path.join(out,`options-${channel}.png`),fullPage:true});
 await evaluate("globalThis.streamFixture.mode='limit'");const failed=await invoke('gemini-refine');assert.equal(failed.ok,false);assert.equal(failed.state,'unknown');
 const saved=await page.evaluate(()=>chrome.storage.local.get(['geminiJobs','geminiUnknown']));assert.equal(saved.geminiJobs[0].status,'unknown');assert.equal(saved.geminiJobs[0].diagnostic.limitKind,'answer');assert.equal(Object.keys(saved.geminiUnknown).length,1);
 const repeat=await invoke('gemini-refine');assert.equal(repeat.ok,false);assert.match(repeat.error,/結果未知/);
 report.transport=await evaluate('globalThis.streamFixture');assert.equal(report.transport.posts,3);assert.equal(report.transport.cancelled,1);assert(pages.every(p=>p.regions.every(r=>r.translation==='原有初譯')));
 report.checks.push('old 30/30 proof reused; local limit preserves drafts, records diagnostics and unknown lock; duplicate submission issues no POST');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(out,`failure-${channel}.png`)}).catch(()=>{});}
finally{await context?.close();report.finished=new Date().toISOString();await writeFile(path.join(out,`extension-${channel}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
