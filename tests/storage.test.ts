import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cachePage,loadPage,settings,ocrReusePages} from '../src/storage';
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
test('legacy Gemini primary selection becomes Google while enabling the separate chapter pass',async()=>{
 const values=storageFixture();values.settings={...defaults,backend:'gemini-web'};const value=await settings();assert.equal(value.backend,'google-web');assert.equal(value.refineAfterChapter,true);
});
test('editing a legacy cached page keeps source metadata and corrections without retranslation',async()=>{
 const values=storageFixture(),key=contentSignature(defaults),original=page('kept',key);Object.assign(original,{sourcePageUrl:'https://example.com/chapter',imageUrl:'https://example.com/page.png',pageIndex:3,savedAt:123});
 await cachePage(original);await cachePage({...page('kept',key),summary:'人工修訂'});const result=await loadPage('kept',key);assert.equal(result?.summary,'人工修訂');assert.equal(result?.sourcePageUrl,original.sourcePageUrl);assert.equal(result?.savedAt,123);assert.equal(values.pageKeys.length,1);
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


test('direct-mode OCR reuse captures compatible pages before the bounded cache rotates',async()=>{
 const values=storageFixture(),google=contentSignature(defaults),direct=contentSignature({...defaults,backend:'gemini-web'});
 for(let n=0;n<29;n++)await cachePage(page('hash-'+n,google));
 const snapshot=await ocrReusePages(defaults);assert.equal(snapshot.size,29);
 for(let n=0;n<29;n++)await cachePage(page('hash-'+n,direct));
 assert.equal(values.pageKeys.length,30);assert(snapshot.has('hash-28'));assert.equal(snapshot.get('hash-28')?.modelKey,google);
 assert.equal((await ocrReusePages({...defaults,ocrProvider:'auto'})).size,0);
});

test('old settings retain standard chapter mode and explicit direct selection persists independently',async()=>{
 const values=storageFixture();values.settings={backend:'google-web'};assert.equal((await settings()).chapterMode,'standard');
 values.settings.chapterMode='gemini-direct';assert.equal((await settings()).chapterMode,'gemini-direct');assert.equal((await settings()).backend,'google-web');
});
