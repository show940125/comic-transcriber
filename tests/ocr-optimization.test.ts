import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as ort from 'onnxruntime-web/webgpu';
import {decodeManga} from '../src/manga-decode';
import {withCandidate,applyCandidate,splitRegion} from '../src/ocr-review';
import {importCorrection,contentSignature,compatiblePageKey} from '../src/core';
import {defaults,type Region,type OcrCandidate} from '../src/types';
import {sessionData,type PageSession} from '../src/page-pipeline';
const region:Region={id:'a',x:10,y:20,width:100,height:200,order:0,source:'原文',translation:'譯文',initialTranslation:'初譯',score:.9,warnings:[],kind:'bubble',render:'auto'};
const candidate:OcrCandidate={source:'候補',profile:'int8',identity:'fixed-model',preprocessing:'canvas-gray-224-v1',decoder:'standard',backend:'wasm',warnings:[],at:1};
test('comparison preserves active text; applying only invalidates changed text',()=>{
 const comparison=withCandidate(region,candidate);assert.equal(comparison.source,'原文');assert.equal(comparison.translation,'譯文');
 const selected=applyCandidate(comparison,candidate);assert.equal(selected.translation,'');assert.equal(selected.initialTranslation,undefined);
 assert.equal(applyCandidate(region,{...candidate,source:'原文'}).translation,'譯文');
 assert.equal(withCandidate(withCandidate({...region,ocr:candidate},{...candidate,source:'二'}),{...candidate,source:'三'}).ocrCandidates?.length,2);
});
test('manual split clears OCR/translation and preserves vertical right-to-left order',()=>{
 let id=0;const parts=splitRegion({...region,ocr:candidate},'x',40,()=>String(++id));
 assert.equal(parts[0].x,40);assert.equal(parts[1].x,10);assert(parts.every(r=>!r.source&&!r.translation&&!r.ocr&&!r.ocrDone));
 assert.throws(()=>splitRegion(region,'x',11));assert.equal(splitRegion(region,'y',60)[0].y,20);
});
test('correction roundtrip reconstructs candidate whitelist and rejects oversized history',()=>{
 const page={schema:1,hash:'h',width:500,height:500,regions:[{...region,ocr:{...candidate,privatePayload:'drop'},ocrCandidates:[candidate]}]};
 const rows=importCorrection(page,'h',500,500);assert.deepEqual(rows[0].ocr,candidate);assert.equal(rows[0].ocrCandidates?.length,1);
 assert.throws(()=>importCorrection({...page,regions:[{...region,ocrCandidates:[candidate,candidate,candidate]}]},'h',500,500));
});
test('model identity partitions cache; threads do not; legacy and private remain isolated',()=>{
 const key=contentSignature(defaults);assert.notEqual(key,contentSignature({...defaults,ocrProfile:'fp32'}));assert.equal(key,contentSignature({...defaults,wasmThreads:4}));
 assert(!compatiblePageKey(key,key.replace('pipeline-4-ocr-identity','pipeline-3-ocr-review')));assert(!compatiblePageKey(key,contentSignature(defaults,'private')));
});
test('an explicitly loaded legacy page stays legacy until a new OCR is adopted',()=>{
 const old=JSON.stringify(['pipeline-3-ocr-review','google-web']),page={blob:new Blob(),image:{naturalWidth:200,naturalHeight:300},regions:[region],hash:'h',modelKey:old,legacyModelKey:old,config:{...defaults}} as PageSession;
 assert.equal(sessionData(page).modelKey,old);page.legacyModelKey=undefined;assert.equal(sessionData(page).modelKey,contentSignature(defaults));assert.equal(old,JSON.stringify(['pipeline-3-ocr-review','google-web']));
});
test('decoder releases KV and logits on cancellation and runtime failure',async()=>{
 for(const fail of ['cancel','throw']){
  const abort=new AbortController(),allocated:ort.Tensor[]=[],released=new Set<ort.Tensor>();
  const tensor=(dims:number[],data?:Float32Array)=>{const t=new ort.Tensor('float32',data??new Float32Array(dims.reduce((a,b)=>a*b,1)),dims),dispose=t.dispose.bind(t);t.dispose=()=>{assert(!released.has(t),'double disposal');released.add(t);dispose();};allocated.push(t);return t;};
  const encoder={session:{inputNames:['image'],outputNames:['hidden']},backend:'wasm'},cross={session:{inputNames:[],outputNames:['cross']},backend:'wasm'},decoder={session:{inputNames:[],outputNames:['logits','past']},backend:'wasm'};
  const input=new ort.Tensor('float32',new Float32Array(1),[1]);
  const run=async(value:typeof encoder):Promise<Record<string,ort.Tensor>>=>{if(value===encoder)return {hidden:tensor([1])};if(value===cross)return {cross:tensor([1])};if(fail==='throw')throw Error('failed');abort.abort();return {logits:tensor([1,6],Float32Array.from([0,0,0,0,0,1])),past:tensor([1])};};
  await assert.rejects(decodeManga(encoder,decoder,cross,input,abort.signal,run));assert.equal(released.size,allocated.length);input.dispose();
 }
});
test('warm synchronous WASM-style decoding services queued cancellation before the whole batch finishes',async()=>{
 const abort=new AbortController(),encoder={session:{inputNames:['image'],outputNames:['hidden']},backend:'wasm'},decoder={session:{inputNames:['input_ids','encoder_hidden'],outputNames:['logits']},backend:'wasm'};
 const input=new ort.Tensor('float32',new Float32Array(1),[1]);let steps=0,hidden:ort.Tensor|undefined;
 const run=async(value:typeof encoder):Promise<Record<string,ort.Tensor>>=>{
  if(value===encoder){const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();abort.abort();};channel.port2.postMessage(null);hidden=new ort.Tensor('float32',new Float32Array(1),[1]);return {hidden};}
  steps++;return {logits:new ort.Tensor('float32',Float32Array.from([0,0,0,0,0,1]),[1,6])};
 };
 await assert.rejects(decodeManga(encoder,decoder,undefined,input,abort.signal,run),{name:'AbortError'});assert(steps<64);assert.throws(()=>hidden!.data);input.dispose();
});
