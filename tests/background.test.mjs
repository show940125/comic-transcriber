import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const bundle=await build({entryPoints:['entrypoints/background.ts'],absWorkingDir:fileURLToPath(new URL('..',import.meta.url)),bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'background-shim',setup(b){b.onResolve({filter:/^wxt\/utils\/define-background$/},()=>({path:'shim',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const defineBackground=fn=>fn;',loader:'js'}));}}]});
const script=Buffer.from(bundle.outputFiles[0].contents).toString('base64');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture({cold=false,delayCreate=false,permissionContains=async()=>true}={}){
 const data={},events=[],handlers=[],registered=[];let document=false,engineGate,closeGate,receiverReady=!cold;const createGate=delayCreate?deferred():undefined;
 const event={addListener(){}};
 globalThis.chrome={runtime:{id:'fixture',getURL:p=>'chrome-extension://fixture/'+p.replace(/^\//,''),onMessage:{addListener:f=>handlers.push(f)},onInstalled:event,sendMessage:async m=>{
  events.push(m.channel);if(m.channel.startsWith('offscreen')&&!receiverReady)throw Error('Could not establish connection. Receiving end does not exist.');if(m.channel==='offscreen-ready')return {ok:true,ready:true};if(m.channel==='offscreen')return engineGate?engineGate.promise:{ok:true,result:[]};if(m.channel==='offscreen-release')return closeGate?closeGate.promise:{ok:true};if(m.channel==='offscreen-runtime-status')return {ok:true,result:{worker:true,models:3}};return {ok:true};
 }},offscreen:{hasDocument:async()=>document,createDocument:async()=>{events.push('create');document=true;if(createGate)await createGate.promise;},closeDocument:async()=>{events.push('close');document=false;}},contextMenus:{onClicked:event},tabs:{onRemoved:event},storage:{onChanged:event,session:{get:async k=>({[k]:data[k]}),set:async v=>Object.assign(data,v),remove:async k=>{delete data[k];}},local:{get:async k=>Object.fromEntries((Array.isArray(k)?k:[k]).map(key=>[key,data[key]])),set:async v=>Object.assign(data,v)}},permissions:{contains:permissionContains},scripting:{unregisterContentScripts:async()=>{},registerContentScripts:async rows=>{registered.push(...rows);}}};
 const entry=await import('data:text/javascript;base64,'+script+'#'+Math.random());entry.default();
 const send=(m,url='chrome-extension://fixture/options.html')=>new Promise((resolve,reject)=>{try{const keep=handlers[0](m,{id:'fixture',url},resolve);if(keep!==true)resolve(undefined);}catch(e){reject(e);}});
 return {send,data,events,registered,engineWait:()=>engineGate=deferred(),closeWait:()=>closeGate=deferred(),isOpen:()=>document,ready:()=>{receiverReady=true;createGate?.resolve();}};
}

test('two cold-start image jobs wait for the same document and receiver before dispatch',async()=>{
 const f=await fixture({cold:true,delayCreate:true}),first=f.send({channel:'engine',id:'cold-one',request:{op:'runtime-info'}});
 await new Promise(r=>setImmediate(r));assert(f.isOpen());
 const second=f.send({channel:'engine',id:'cold-two',request:{op:'runtime-info'}});await new Promise(r=>setImmediate(r));
 f.ready();const results=await Promise.all([first,second]);
 assert(results.every(r=>r.ok),JSON.stringify(results));assert.equal(f.events.filter(x=>x==='create').length,1);assert.equal(f.events.filter(x=>x==='offscreen').length,2);
 delete globalThis.chrome;
});

test('a document that exists before its module listener is ready is handshaken before work',async()=>{
 const f=await fixture({cold:true});const timer=setTimeout(f.ready,30);
 try{const result=await f.send({channel:'engine',id:'late-listener',request:{op:'runtime-info'}});assert.equal(result.ok,true,result.error);assert(f.events.includes('offscreen-ready'));}
 finally{clearTimeout(timer);delete globalThis.chrome;}
});

test('work connection failures after readiness are surfaced without replaying engine or Gemini submissions',async()=>{
 for(const channel of ['engine','gemini-refine']){
  const f=await fixture();f.data.geminiValidation={status:'passed'};const original=chrome.runtime.sendMessage;let submissions=0;
  chrome.runtime.sendMessage=async message=>{if(message.channel===(channel==='engine'?'offscreen':'offscreen-gemini')){submissions++;throw Error('Could not establish connection. Receiving end does not exist.');}return original(message);};
  try{const result=await f.send({channel,id:'one-submission',request:{op:'runtime-info'},pages:[],settings:{}});assert.equal(result.ok,false);assert.equal(submissions,1);}
  finally{await new Promise(r=>setImmediate(r));delete globalThis.chrome;}
 }
});
test('reading unloaded status does not create offscreen or inference resources',async()=>{
 const f=await fixture(),result=await f.send({channel:'runtime-status'});assert.equal(result.result.phase,'unloaded');assert(!f.events.includes('create'));
});
test('pause release drains an active inference and a new job waits for closing before recreating',async()=>{
 const f=await fixture(),engine=f.engineWait(),closing=f.closeWait(),first=f.send({channel:'engine',id:'first',request:{op:'detect'}});
 await new Promise(r=>setImmediate(r));assert(f.isOpen());const release=await f.send({channel:'runtime-release'});assert.equal(release.busy,true);assert(!f.events.includes('close'));
 engine.resolve({ok:true,result:[]});await first;await new Promise(r=>setImmediate(r));assert(f.events.includes('offscreen-release'));
 const second=f.send({channel:'engine',id:'second',request:{op:'detect'}});await new Promise(r=>setImmediate(r));assert.equal(f.events.filter(x=>x==='create').length,1);
 closing.resolve({ok:true});await second;assert.equal(f.events.filter(x=>x==='create').length,2);assert(f.isOpen());delete globalThis.chrome;
});
test('Gemini stays gated before protocol validation without waking the model runtime',async()=>{
 const f=await fixture(),result=await f.send({channel:'gemini-translate',regions:[],pageHash:'p'});assert.equal(result.ok,false);assert.match(result.error,/30 批/);assert(!f.events.includes('create'));delete globalThis.chrome;
});
test('whole-chapter Gemini uses the validation gate and offscreen refinement operation',async()=>{
 const f=await fixture();const blocked=await f.send({channel:'gemini-refine',pages:[]});assert.equal(blocked.ok,false);assert(!f.events.includes('create'));
 f.data.geminiValidation={status:'passed'};const result=await f.send({channel:'gemini-refine',pages:[],settings:{}});assert.equal(result.ok,true);assert(f.events.includes('offscreen-gemini'));delete globalThis.chrome;
});
test('content scripts can check Gemini readiness through the background without loading inference',async()=>{
 const f=await fixture();const first=await f.send({channel:'gemini-status'},'https://example.com/chapter');assert.equal(first.result.ready,false);
 f.data.geminiValidation={status:'passed'};const ready=await f.send({channel:'gemini-status'},'https://example.com/chapter');assert.equal(ready.result.ready,true);assert(!f.events.includes('create'));delete globalThis.chrome;
});
test('Google 429 blocks queued requests across pages until explicit manual resume',async()=>{
 const f=await fixture(),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(calls===1?null:'[[["你好"]]]',{status:calls===1?429:200});};
 try{const [one,two]=await Promise.all([f.send({channel:'google-text',id:'one',source:'こんにちは'}),f.send({channel:'google-text',id:'two',source:'さようなら'})]);assert.equal(one.status,429);assert.equal(two.ok,false);assert.match(two.error,/429/);assert.equal(calls,1);await f.send({channel:'translation-resume'});const next=await f.send({channel:'google-text',id:'next',source:'こんにちは'});assert.equal(next.status,200);assert.equal(calls,2);}finally{globalThis.fetch=original;delete globalThis.chrome;}
});
test('unknown Gemini locks survive bounded diagnostic rotation until manual unlock',async()=>{
 const f=await fixture(),url='chrome-extension://fixture/offscreen.html',job={requestId:'old',inputHash:'a'.repeat(64),pageHash:'page',status:'submitted'};
 assert.equal((await f.send({channel:'gemini-record',job},url)).ok,true);await f.send({channel:'gemini-record',job:{...job,status:'unknown'}},url);
 for(let n=0;n<31;n++)await f.send({channel:'gemini-record',job:{requestId:String(n),inputHash:String(n).padStart(64,'0'),status:'complete'}},url);
 assert.equal(f.data.geminiJobs.length,30);assert(!f.data.geminiJobs.some(j=>j.requestId==='old'));
 const retry=await f.send({channel:'gemini-record',job:{...job,requestId:'retry'}},url);assert.equal(retry.ok,false);assert.match(retry.error,/結果未知/);
 await f.send({channel:'gemini-unlock'});assert.equal((await f.send({channel:'gemini-record',job:{...job,requestId:'manual-retry'}},url)).ok,true);delete globalThis.chrome;
});

test('a different CDN origin can be fetched with broad granted website access',async()=>{
 const f=await fixture(),original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});};
 try{const result=await f.send({channel:'fetch-image',url:'https://a2.gold-usergeneratedcontent.net/test.png'});assert.equal(result.ok,true);assert.equal(result.mime,'image/png');assert.equal(result.base64,'AQID');assert.equal(calls,1);assert(!f.events.includes('create'));}finally{globalThis.fetch=original;delete globalThis.chrome;}
});
test('withheld browser access is reported clearly and private endpoints stay blocked',async()=>{
 const f=await fixture({permissionContains:async()=>false}),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected fetch');};
 try{
  const result=await f.send({channel:'fetch-image',url:'https://a2.gold-usergeneratedcontent.net/test.png'});assert.equal(result.ok,false);assert.equal(result.code,'HOST_ACCESS_REQUIRED');assert.match(result.error,/授權所有網站與圖片 CDN/);
  const privateResult=await f.send({channel:'fetch-image',url:'http://127.0.0.1/private.png'});assert.equal(privateResult.ok,false);assert.equal(calls,0);
 }finally{globalThis.fetch=original;delete globalThis.chrome;}
});
test('automatic injection retains only explicitly selected concrete websites after broad grants',async()=>{
 const f=await fixture();f.data.settings={auto:true,autoSites:['https://*/*','http://*/*','https://manga.example/*']};
 try{assert.equal((await f.send({channel:'auto-scripts'})).ok,true);assert.deepEqual(f.registered[0].matches,['https://manga.example/*']);}
 finally{delete globalThis.chrome;}
});
