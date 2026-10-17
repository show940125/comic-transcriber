import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CorrectionImportBroker,correctionFileLimit,correctionRegions,correctionImportLifetime} from '../src/correction-import';
import {contentSignature,compatiblePageKey} from '../src/core';
import {sessionData} from '../src/page-pipeline';
import {defaults} from '../src/types';
const binding={editorId:'11111111-1111-4111-8111-111111111111',hash:'a'.repeat(64),width:100,height:100};
const source={id:'extension',tab:{id:1},frameId:2,documentId:'source-doc',url:'https://manga.example/chapter'} as chrome.runtime.MessageSender;
const pageUrl='chrome-extension://extension/correction-import.html';
const row={id:'a',source:'こんにちは',translation:'你好',x:0,y:0,width:50,height:50,order:0,score:1,warnings:[],kind:'bubble',render:'auto'};
test('private file sessions never share website cache identity, including later pipeline saves',()=>{
  const website=contentSignature(defaults),privateKey=contentSignature(defaults,'private');assert.notEqual(privateKey,website);assert(!compatiblePageKey(privateKey,website));assert(!compatiblePageKey(website,privateKey));
  const page=sessionData({image:{naturalWidth:100,naturalHeight:100},config:defaults,regions:[],hash:binding.hash,modelKey:website,cacheScope:'private'} as any);assert.equal(page.modelKey,privateKey);
});
function fixture(deliver=async()=>({ok:true})){
  let now=1000;const deliveries:any[]=[];
  const broker=new CorrectionImportBroker({extensionId:'extension',pageUrl,now:()=>now,uuid:()=> 'session',createTab:async()=>9,activateTab:async()=>{},deliver:async(s,regions)=>{deliveries.push({s,regions});return deliver();}});
  const importer={id:'extension',tab:{id:9},frameId:0,url:pageUrl+'#session'} as chrome.runtime.MessageSender;
  return {broker,importer,deliveries,advance:()=>now+=correctionImportLifetime,open:()=>broker.dispatch({channel:'correction-import-open',binding},source),send:(channel:string,extra:object={},sender=importer)=>broker.dispatch({channel,id:'session',...extra},sender)};
}
test('private import validates ownership, transfers a deep whitelist, and consumes acknowledgement',async()=>{
  const f=fixture();await f.open();assert.deepEqual((await f.send('correction-import-read')).binding,binding);
  const extra={...row,secret:'raw-secret',ocrBox:{x:0,y:0,width:20,height:20,secret:'nested-secret'},bubbleBox:{x:0,y:0,width:50,height:50,extra:{secret:true}}};
  await f.send('correction-import-submit',{regions:[extra]});assert.equal(f.deliveries.length,1);
  assert(!JSON.stringify(f.deliveries).includes('secret'));assert.deepEqual(f.deliveries[0].regions[0].ocrBox,{x:0,y:0,width:20,height:20});
  await assert.rejects(f.send('correction-import-submit',{regions:[row]}),/失效/);
});
test('read and submit reject wrong extension, tab, frame and exact page URL',async()=>{
  const f=fixture();await f.open();
  for(const patch of [{id:'other'},{tab:{id:8}},{frameId:1},{url:pageUrl+'.evil#session'},{url:pageUrl+'?x#session'},{url:pageUrl}]){
    for(const op of ['correction-import-read','correction-import-submit'])await assert.rejects(f.send(op,{regions:[row]},{...f.importer,...patch} as any));
  }
  assert.equal(f.deliveries.length,0);
});
test('only original source editor/document can revoke; sibling tabs cannot revoke',async()=>{
  const f=fixture();await f.open();
  for(const sender of [{...source,tab:{id:2}},{...source,frameId:0},{...source,documentId:'other'},{...source,url:source.url+'/other'}])await f.send('correction-import-invalidate',{editorId:binding.editorId},sender as any);
  assert.equal((await f.send('correction-import-read')).state,'ready');
  await f.send('correction-import-invalidate',{editorId:binding.editorId},source);await assert.rejects(f.send('correction-import-read'),/失效/);
});
test('expiry, tab close, source navigation and import navigation invalidate sessions',async()=>{
  for(const invalidate of [(f:any)=>f.advance(),(f:any)=>f.broker.invalidateTab(1),(f:any)=>f.broker.invalidateTab(9),(f:any)=>f.broker.navigating(1,{status:'loading'}),(f:any)=>f.broker.navigating(1,{url:'https://manga.example/next'}),(f:any)=>f.broker.navigating(9,{url:pageUrl+'#another'})]){
    const f=fixture();await f.open();invalidate(f);await assert.rejects(f.send('correction-import-read'),/失效/);
  }
  const f=fixture();await assert.rejects(f.send('correction-import-read'),/失效/); // worker restart: no restored session
});
test('duplicate delivery and unknown acknowledgement never automatically retry',async()=>{
  let settle!:(value:{ok:boolean})=>void;const f=fixture(()=>new Promise(resolve=>{settle=resolve;}));await f.open();
  const first=f.send('correction-import-submit',{regions:[row]});await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.send('correction-import-submit',{regions:[row]}),/已提交/);settle({ok:true});await first;assert.equal(f.deliveries.length,1);
  const unknown=fixture(async()=>{throw Error('lost acknowledgement');});await unknown.open();await assert.rejects(unknown.send('correction-import-submit',{regions:[row]}),/lost/);
  assert.equal((await unknown.send('correction-import-read')).state,'unknown');await assert.rejects(unknown.send('correction-import-submit',{regions:[row]}),/已提交/);assert.equal(unknown.deliveries.length,1);
});
test('invalid payloads cannot reach destination; closing during delivery prevents success',async()=>{
  const f=fixture();await f.open();
  for(const regions of [[row,row],[{...row,x:99}],[{...row,source:'x'.repeat(1501)}],[{...row,ocrBox:{x:-1,y:0,width:2,height:2}}]])await assert.rejects(f.send('correction-import-submit',{regions}));
  assert.equal(f.deliveries.length,0);assert.throws(()=>correctionRegions([{...row,unused:'x'.repeat(correctionFileLimit)}],binding),/2 MB/);
  let finish!:(value:{ok:boolean})=>void;const closing=fixture(()=>new Promise(resolve=>{finish=resolve;}));await closing.open();const pending=closing.send('correction-import-submit',{regions:[row]});await new Promise(resolve=>setImmediate(resolve));closing.broker.invalidateTab(1);finish({ok:true});await assert.rejects(pending,/失效/);
});
