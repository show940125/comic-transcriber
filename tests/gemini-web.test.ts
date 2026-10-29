import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseGeminiFrames,geminiBody,anonymousGemini,geminiTranslate,translationBatches,GeminiFailure,bootstrapVersion,geminiStreamLimits} from '../src/gemini-web';
import {defaults,type Region} from '../src/types';
const region=(id:string,source='こんにちは'):Region=>({id,source,translation:'',order:Number(id)||0,x:0,y:0,width:50,height:50,score:1,warnings:[],kind:'bubble',render:'auto'});
const frame=(text:string)=>JSON.stringify([['wrb.fr','rpc',JSON.stringify([null,null,null,null,[['candidate',[text]]]])]]);
test('bootstrap accepts observed Gemini uiserver rename and legacy server label',()=>{assert.equal(bootstrapVersion('cfb2h:boq_gemini-web-uiserver_20261013.29_p0'),'boq_gemini-web-uiserver_20261013.29_p0');assert.equal(bootstrapVersion('boq_assistant-bard-web-server_20260716.08_p0'),'boq_assistant-bard-web-server_20260716.08_p0');assert.equal(bootstrapVersion('sign-in landing page'),undefined);});
test('anonymous stream assembles complete final candidate across framing lines',()=>{
 assert.equal(parseGeminiFrames(")]}'\n\n123\n"+frame('古')+'\n99\n'+frame('最後翻譯')),'最後翻譯');assert.throws(()=>parseGeminiFrames(frame('')+'\n[truncated'));
 const data=JSON.parse(JSON.parse(geminiBody('hello').get('f.req')!)[1]);assert.equal(data[0][0],'hello');assert.equal(data[79],null);
});

test('a 19-page cumulative stream exceeding the old 2M limit preserves the final answer with bounded diagnostics',async()=>{
 const rows=Array.from({length:19*12},(_,n)=>({id:`p${Math.floor(n/12)+1}r${n%12+1}`,text:`這是第${n+1}框的原創測試對話。`.repeat(4)})),text=JSON.stringify(rows);
 const raw=")]}'\n\n"+Array.from({length:320},(_,n)=>frame(text.slice(0,Math.ceil(text.length*(n+1)/320)))+'\n').join('');
 assert(raw.length>2_000_000);const bytes=new TextEncoder().encode(raw);let posts=0,offset=0;
 const fetcher:typeof fetch=async(_url,init)=>{if(init?.method!=='POST')return new Response('boq_gemini-web-uiserver_20261013.29_p0');posts++;
  return new Response(new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;}const end=Math.min(offset+8191,bytes.length);c.enqueue(bytes.subarray(offset,end));offset=end;}}));};
 const result=await anonymousGemini('19-page fixture',undefined,fetcher);
 assert.equal(result.text,text);assert.equal(posts,1);assert(result.raw.length<=24000);
 assert.equal(result.rawTruncated,true);assert.equal(result.diagnostic?.receivedCharacters,raw.length);assert.equal(result.diagnostic?.receivedBytes,bytes.length);assert.equal(result.diagnostic?.frames,320);
});

test('individual frame and answer limits remain bounded independently of total transfer size',()=>{
 assert.throws(()=>parseGeminiFrames('['+' '.repeat(geminiStreamLimits.frameCharacters)),(e:any)=>e.state==='unknown'&&e.diagnostic.limitKind==='frame');
 assert.throws(()=>parseGeminiFrames(frame('字'.repeat(geminiStreamLimits.answerCharacters+1))),(e:any)=>e.state==='unknown'&&e.diagnostic.limitKind==='answer');
});

test('a local answer limit cancels the submitted stream, keeps drafts and records an unknown result without retry',async()=>{
 let posts=0,cancelled=false;const jobs:any[]=[];
 const fetcher:typeof fetch=async(_url,init)=>{if(init?.method!=='POST')return new Response('boq_gemini-web-uiserver_20261013.29_p0');posts++;
  return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame('字'.repeat(geminiStreamLimits.answerCharacters+1))+'\n'));},cancel(){cancelled=true;}}));};
 const input=region('1');input.translation='';
 await assert.rejects(geminiTranslate([input],defaults,'limit-fixture',undefined,async j=>{jobs.push(j);},(prompt,signal)=>anonymousGemini(prompt,signal,fetcher)),(e:any)=>e.state==='unknown'&&e.partial[0].translation==='');
 assert.equal(posts,1);assert(cancelled);assert.equal(jobs.at(-1).status,'unknown');assert.equal(jobs.at(-1).diagnostic.cause,'response_limit');assert(jobs.at(-1).diagnostic.receivedBytes>0);assert.equal(input.source,'こんにちは');
});

test('malformed frames after a valid snapshot fail instead of applying that partial answer',()=>{
 assert.throws(()=>parseGeminiFrames(frame('部分答案')+'\n'+frame('後續答案').slice(0,-3)),/串流分段格式不完整/);
});
test('batching enforces reading order, region count and Unicode source budget',()=>{
 const input=Array.from({length:25},(_,n)=>region(String(n)));assert.deepEqual(translationBatches(input).map(g=>g.length),[24,1]);
 assert.deepEqual(translationBatches(Array.from({length:5},(_,n)=>region(String(n),'あ'.repeat(1500)))).map(g=>g.length),[4,1]);
});
test('anonymous transport omits credentials and never retries an unknown submission',async()=>{
 let calls=0;const fetcher:typeof fetch=async(_url,init)=>{assert.equal(init?.credentials,'omit');calls++;if(calls===1)return new Response('boq_assistant-bard-web-server_20261015.01_p0');throw new TypeError('network disconnected');};
 await assert.rejects(anonymousGemini('hello',undefined,fetcher),(e:any)=>e.state==='unknown');assert.equal(calls,2);
});
test('Gemini maps shuffled IDs exactly and allows only one completed-format repair',async()=>{
 let calls=0;const jobs:any[]=[];const output=await geminiTranslate([region('1'),region('2')],defaults,'hash',undefined,async job=>{jobs.push(job);},async()=>{calls++;return {text:calls===1?'bad JSON':'[{"id":"2","text":"再見"},{"id":"1","text":"你好"}]',raw:'fixture',build:'fixture'};});
 assert.equal(calls,2);assert.deepEqual(output.map(r=>r.translation),['你好','再見']);assert.equal(jobs.at(-1).status,'complete');assert(jobs[0].inputHash);
 let invalid=0;await assert.rejects(geminiTranslate([region('1')],defaults,'hash',undefined,undefined,async()=>{invalid++;return {text:'[{"id":"other","text":"錯框"}]',raw:'fixture',build:'fixture'};}));assert.equal(invalid,2);
});

test('cancelling after submission retains an unknown lock instead of allowing automatic resubmission',async()=>{
 const controller=new AbortController(),jobs:any[]=[];let calls=0;
 const fetcher:typeof fetch=async(_url,init)=>{calls++;if(init?.method!=='POST')return new Response('boq_gemini-web-uiserver_20261013.29_p0');controller.abort();throw controller.signal.reason;};
 await assert.rejects(geminiTranslate([region('1')],defaults,'hash',controller.signal,async job=>{jobs.push(job);},(prompt,signal)=>anonymousGemini(prompt,signal,fetcher)),(e:any)=>e.state==='unknown');
 assert.equal(calls,2);assert.equal(jobs.at(-1).status,'unknown');
});
test('a failed second batch preserves first translations and an unknown result never triggers repair',async()=>{
 let calls=0;const jobs:any[]=[];
 await assert.rejects(geminiTranslate(Array.from({length:25},(_,n)=>region(String(n))),defaults,'hash',undefined,async job=>{jobs.push(job);},async()=>{calls++;if(calls===2)throw new GeminiFailure('unknown','unknown');return {text:JSON.stringify(Array.from({length:24},(_,n)=>({id:String(n),text:'你好'}))),raw:'fixture',build:'fixture'};}),(e:any)=>e.partial.filter((r:Region)=>r.translation).length===24);
 assert.equal(calls,2);assert.equal(jobs.at(-1).status,'unknown');
});


test('180-second deadline covers response body and reports timeout separately from cancellation',async()=>{
 const {geminiTimeoutMs}=await import('../src/gemini-web');assert.equal(geminiTimeoutMs,180000);
 const original=AbortSignal.timeout,timeout=new AbortController(),limits:number[]=[];
 AbortSignal.timeout=(ms:number)=>{limits.push(ms);return ms===180000?timeout.signal:original(ms);};
 let posts=0;
 try{
  const fetcher:typeof fetch=async(_url,init)=>{if(init?.method!=='POST')return new Response('boq_gemini-web-uiserver_20261013.29_p0');posts++;
   return new Response(new ReadableStream({start(controller){init.signal!.addEventListener('abort',()=>controller.error(init.signal!.reason),{once:true});queueMicrotask(()=>timeout.abort(new DOMException('timed out','TimeoutError')));}}));
  };
  await assert.rejects(anonymousGemini('whole chapter',undefined,fetcher),(e:any)=>e.state==='unknown'&&e.diagnostic.cause==='timeout'&&e.diagnostic.timeoutMs===180000&&/180 秒/.test(e.message));
  assert.equal(posts,1);assert.deepEqual(limits,[20000,180000]);
 }finally{AbortSignal.timeout=original;}
});

test('a user cancellation after headers is reported as cancel and retains unknown submission state',async()=>{
 const abort=new AbortController();let posts=0;
 const fetcher:typeof fetch=async(_url,init)=>{if(init?.method!=='POST')return new Response('boq_gemini-web-uiserver_20261013.29_p0');posts++;
 return new Response(new ReadableStream({start(c){init.signal!.addEventListener('abort',()=>c.error(init.signal!.reason),{once:true});queueMicrotask(()=>abort.abort());}}));};
 await assert.rejects(anonymousGemini('whole chapter',abort.signal,fetcher),(e:any)=>e.state==='unknown'&&e.diagnostic.cause==='cancel'&&/使用者取消/.test(e.message));assert.equal(posts,1);
});
