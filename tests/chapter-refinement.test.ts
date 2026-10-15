import {test} from 'node:test';import assert from 'node:assert/strict';
import {refineChapter,refinementInput,chapterSnapshot,checkedRefinement,chapterFingerprint,refinementContext} from '../src/chapter-refinement';
import {importCorrection} from '../src/core';
import {defaults,type PageData} from '../src/types';
const page=(n:number):PageData=>({schema:1,hash:`hash-${n}`,width:200,height:200,title:'',chapter:'',glossary:'',summary:'',modelKey:'google',regions:[{id:'same-id',x:10,y:10,width:100,height:100,order:0,source:n===16?'葵が戻ってきた':'葵ちゃんを待つ',translation:'Google 初譯 '+n,score:1,warnings:[],kind:'bubble',render:'auto'}]});

test('one whole-chapter request contains all 17 pages and maps shuffled page-qualified IDs without cross-page collisions',async()=>{
 const pages=Array.from({length:17},(_,n)=>page(n)),before=chapterSnapshot(pages),jobs:any[]=[];let calls=0;
 const result=await refineChapter(pages,{...defaults,glossary:'葵＝小葵'},undefined,async j=>{jobs.push(j);},async prompt=>{
   calls++;const input=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));assert.equal(input.pages.length,17);assert.equal(input.pages[16].regions[0].source,'葵が戻ってきた');assert.equal(input.glossary,'葵＝小葵');
   return {text:JSON.stringify(input.pages.map((p:any)=>({id:p.regions[0].id,text:`小葵 ${p.page}`})).reverse()),raw:'fixture',build:'fixture'};
 });
 assert.equal(calls,1);assert.equal(result.regions,17);assert.equal(result.changed,17);assert.equal(chapterSnapshot(pages),before);
 const output=checkedRefinement(pages,before,result);assert.deepEqual(output.map(p=>p.regions[0].translation),Array.from({length:17},(_,n)=>`小葵 ${n+1}`));assert.equal(output[3].regions[0].initialTranslation,'Google 初譯 3');
 const fingerprint=await chapterFingerprint(output);assert(output.every(p=>p.refinement?.outputFingerprint===fingerprint));assert.equal(jobs.at(-1).kind,'chapter-refinement');
});
test('a bad full-chapter response gets at most one format repair and leaves every draft unchanged',async()=>{
 const pages=[page(1),page(2)],before=chapterSnapshot(pages);let calls=0;
 await assert.rejects(refineChapter(pages,defaults,undefined,undefined,async()=>{calls++;return {text:'[{"id":"wrong","text":"錯框"}]',raw:'fixture',build:'fixture'};}));
 assert.equal(calls,2);assert.equal(chapterSnapshot(pages),before);
});
test('chapter identity guards reject stale edits and wrong page mappings before any output is accepted',async()=>{
 const pages=[page(1),page(2)],snapshot=chapterSnapshot(pages),result={pages:structuredClone(pages),fingerprint:'x'};
 result.pages[1].hash='another';assert.throws(()=>checkedRefinement(pages,snapshot,result));assert.equal(pages[0].regions[0].translation,'Google 初譯 1');
 result.pages=structuredClone(pages);pages[0].regions[0].source='人工修改';assert.throws(()=>checkedRefinement(pages,snapshot,result));
});
test('review-only OCR stays in full context but is excluded from required output and baseline replacement',async()=>{
 const pages=[page(1),page(2)];pages[1].regions[0].needsReview=true;pages[1].regions[0].translation='';
 const input=refinementInput(pages,defaults);assert.equal(JSON.parse(input.payload).pages.length,2);assert.equal(input.expected.length,1);
 const output=await refineChapter(pages,defaults,undefined,undefined,async()=>({text:JSON.stringify([{id:input.expected[0].id,text:'校訂'}]),raw:'fixture',build:'fixture'}));assert.equal(output.pages[1].regions[0].translation,'');assert.equal(output.pages[1].regions[0].initialTranslation,undefined);
});
test('oversize chapters fail locally and preserve the original initial translation on later correction',async()=>{
 assert.throws(()=>refinementInput(Array.from({length:61},(_,n)=>page(n)),defaults));const huge=page(1);huge.regions[0].source='あ'.repeat(50000);assert.throws(()=>refinementInput([huge],defaults));
 const p=page(1);p.regions[0].initialTranslation='最初 Google';p.regions[0].translation='人工校訂';const input=refinementInput([p],defaults);assert.equal(JSON.parse(input.payload).pages[0].regions[0].draft,'最初 Google');assert.equal(JSON.parse(input.payload).pages[0].regions[0].current,'人工校訂');
});
test('changing the chapter glossary invalidates refinement reuse independently of Google OCR caches',async()=>{
 assert.notEqual(await refinementContext(defaults),await refinementContext({...defaults,glossary:'葵＝小葵'}));assert.equal(await refinementContext(defaults),await refinementContext({...defaults,wasmThreads:4}));
});
test('correction JSON retains the Google baseline and rejects malformed baseline data',()=>{
 const p=page(1);p.regions[0].initialTranslation='Google 初譯';assert.equal(importCorrection(p,p.hash,p.width,p.height)[0].initialTranslation,'Google 初譯');
 (p.regions[0] as any).initialTranslation={html:'bad'};assert.throws(()=>importCorrection(p,p.hash,p.width,p.height));
});
