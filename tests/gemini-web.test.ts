import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseGeminiFrames,geminiBody,anonymousGemini,geminiTranslate,translationBatches,GeminiFailure,bootstrapVersion} from '../src/gemini-web';
import {defaults,type Region} from '../src/types';
const region=(id:string,source='こんにちは'):Region=>({id,source,translation:'',order:Number(id)||0,x:0,y:0,width:50,height:50,score:1,warnings:[],kind:'bubble',render:'auto'});
const frame=(text:string)=>JSON.stringify([['wrb.fr','rpc',JSON.stringify([null,null,null,null,[['candidate',[text]]]])]]);
test('bootstrap accepts observed Gemini uiserver rename and legacy server label',()=>{assert.equal(bootstrapVersion('cfb2h:boq_gemini-web-uiserver_20261013.29_p0'),'boq_gemini-web-uiserver_20261013.29_p0');assert.equal(bootstrapVersion('boq_assistant-bard-web-server_20260716.08_p0'),'boq_assistant-bard-web-server_20260716.08_p0');assert.equal(bootstrapVersion('sign-in landing page'),undefined);});
test('anonymous stream assembles complete final candidate across framing lines',()=>{
 assert.equal(parseGeminiFrames(")]}'\n\n123\n"+frame('古')+'\n99\n'+frame('最後翻譯')),'最後翻譯');assert.throws(()=>parseGeminiFrames(frame('')+'\n[truncated'));
 const data=JSON.parse(JSON.parse(geminiBody('hello').get('f.req')!)[1]);assert.equal(data[0][0],'hello');assert.equal(data[79],null);
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
