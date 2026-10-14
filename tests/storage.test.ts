import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cachePage,loadPage} from '../src/storage';
import {contentSignature} from '../src/core';
import {defaults,type PageData} from '../src/types';
function storageFixture(){
 const values:Record<string,any>=Object.create(null);
 (globalThis as any).chrome={storage:{local:{get:async(keys:string|string[])=>{const selected=Array.isArray(keys)?keys:[keys];return Object.fromEntries(selected.filter(k=>k in values).map(k=>[k,structuredClone(values[k])]));},set:async(data:Record<string,any>)=>{for(const[k,v]of Object.entries(data))values[k]=structuredClone(v);},remove:async(keys:string[])=>{for(const key of keys)delete values[key];}}}};
 return values;
}
function page(hash:string,modelKey:string):PageData{return {schema:1,hash,width:100,height:100,regions:[],title:'',chapter:'',glossary:'',summary:'已翻譯的對白',modelKey};}
test('concurrent page saves retain both cache keys and both correction payloads',async()=>{
 const values=storageFixture(),key=contentSignature(defaults),one=page('first',key),two=page('second',key);one.summary='第一張人工校正';two.summary='第二張人工校正';
 await Promise.all([cachePage(one),cachePage(two)]);assert.equal(values.pageKeys.length,2);assert.equal((await loadPage('first',key))?.summary,one.summary);assert.equal((await loadPage('second',key))?.summary,two.summary);
});
test('legacy Google cache restores translated page across unused previous-page summaries',async()=>{
 const values=storageFixture(),current=contentSignature(defaults),legacy=JSON.parse(current);legacy[9]='作品';legacy[12]='先前對白';const key=`page:abc:${JSON.stringify(legacy)}`;
 values[key]=page('abc',JSON.stringify(legacy));values.pageKeys=[key];
 const result=await loadPage('abc',current);assert.equal(result?.summary,'已翻譯的對白');assert.equal(result?.modelKey,current);
 await cachePage(result!);assert.deepEqual(values.pageKeys,[`page:abc:${current}`]);assert.equal(values[key],undefined);assert.equal((await loadPage('abc',current))?.summary,'已翻譯的對白');
});
test('local LLM context changes cannot reuse legacy page and cache migration does not evict other pages',async()=>{
 const values=storageFixture(),local=contentSignature({...defaults,backend:'local'}),legacy=JSON.parse(local);legacy[12]='先前對白';const key=`page:abc:${JSON.stringify(legacy)}`;
 values[key]=page('abc',JSON.stringify(legacy));values.pageKeys=[key];assert.equal(await loadPage('abc',local),undefined);
 const google=contentSignature(defaults),prior=JSON.parse(google);prior[12]='上一頁';const googleKey=`page:xyz:${JSON.stringify(prior)}`;values[googleKey]=page('xyz',JSON.stringify(prior));values.pageKeys=[googleKey,key];
 await cachePage(page('xyz',google));assert.equal(values.pageKeys.length,2);assert(values[key]);assert(!values[googleKey]);
});
