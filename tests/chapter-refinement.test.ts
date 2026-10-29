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


test('29-page direct translation sends all Japanese once, omits Google drafts and preserves exact IDs',async()=>{
 const pages=Array.from({length:29},(_,n)=>page(n));for(const p of pages)p.regions[0].translation='';
 const before=chapterSnapshot(pages),jobs:any[]=[];let calls=0;
 const result=await refineChapter(pages,defaults,undefined,async j=>{jobs.push(j);},async prompt=>{
   calls++;const input=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));assert.equal(input.pages.length,29);
   assert(input.pages.every((p:any)=>p.regions.every((r:any)=>!('draft' in r)&&!('current' in r)&&r.id.length<12)));
   return {text:JSON.stringify(input.pages.map((p:any)=>({id:p.regions[0].id,text:'直譯第 '+p.page+' 頁'})).reverse()),raw:'fixture',build:'fixture'};
 },true);
 assert.equal(calls,1);assert.equal(result.regions,29);assert.equal(chapterSnapshot(pages),before);
 const output=checkedRefinement(pages,before,result);assert.equal(output[28].regions[0].translation,'直譯第 29 頁');
 assert(output.every(p=>p.regions[0].initialTranslation===undefined&&p.refinement?.mode==='direct'));
 assert.equal(jobs[0].kind,'chapter-translation');assert.equal(jobs[0].pages,29);assert(jobs[0].inputBytes>0);
 assert.notEqual(await refinementContext(defaults,true),await refinementContext(defaults));
});

test('direct translation rejects missing, duplicate or extra IDs and preserves OCR on failure',async()=>{
 const pages=[page(1),page(2)];pages.forEach(p=>p.regions[0].translation='');const snapshot=chapterSnapshot(pages);
 for(const reply of [[{id:'p1r1',text:'缺頁'}],[{id:'p1r1',text:'重複'},{id:'p1r1',text:'重複'}],[{id:'p1r1',text:'好'},{id:'p2r1',text:'好'},{id:'extra',text:'多餘'}]]){
   let calls=0;await assert.rejects(refineChapter(pages,defaults,undefined,undefined,async()=>{calls++;return {text:JSON.stringify(reply),raw:'fixture',build:'fixture'};},true));assert.equal(calls,2);assert.equal(chapterSnapshot(pages),snapshot);
 }
});

test('unknown chapter stream failure records timing diagnostics and never performs format repair',async()=>{
 const {GeminiFailure}=await import('../src/gemini-web');const jobs:any[]=[];let calls=0;
 const error=Object.assign(new GeminiFailure('timeout','unknown'),{diagnostic:{cause:'timeout',elapsedMs:180001}});
 await assert.rejects(refineChapter([page(1)],defaults,undefined,async j=>{jobs.push(j);},async()=>{calls++;throw error;}));
 assert.equal(calls,1);assert.equal(jobs.at(-1).status,'unknown');assert.equal(jobs.at(-1).diagnostic.cause,'timeout');
});

test('chapter success preserves bounded-stream counters and the truncated raw marker',async()=>{
 const jobs:any[]=[],diagnostic={receivedCharacters:4_000_000,receivedBytes:6_000_000,frames:320,peakFrameCharacters:30000,answerCharacters:30,rawExcerptCharacters:24000};
 await refineChapter([page(1)],defaults,undefined,async job=>{jobs.push(job);},async()=>({text:'[{"id":"p1r1","text":"校訂成功"}]',raw:'x'.repeat(24000),rawTruncated:true,diagnostic,build:'fixture'}));
 assert.equal(jobs.at(-1).rawTruncated,true);assert.deepEqual(jobs.at(-1).diagnostic,diagnostic);assert.equal(jobs.at(-1).raw.length,24000);
});


test('switching to Google second-pass mode never relabels or overwrites direct translations as Google drafts',()=>{
 const p=page(1);p.refinement={fingerprint:'f',at:1,provider:'gemini-web',promptVersion:3,mode:'direct'};
 assert.throws(()=>refinementInput([p],defaults),/Gemini 直譯/);assert.equal(p.regions[0].initialTranslation,undefined);
 assert.equal(refinementInput([p],defaults,true).expected.length,1);
});
