import type {OcrCandidate,Region} from './types';
import {needsOcrReview} from './ocr-quality';
export function cleanOcrCandidate(value:unknown):OcrCandidate|undefined {
  if(value===undefined)return;
  const v=value as OcrCandidate;
  if(!v||typeof v.source!=='string'||v.source.length>1500||!['int8','fp32','legacy'].includes(v.profile)||!['standard','kv','unknown'].includes(v.decoder)||typeof v.identity!=='string'||v.identity.length>4096||typeof v.preprocessing!=='string'||v.preprocessing.length>100||typeof v.backend!=='string'||v.backend.length>150||!Number.isFinite(v.at)||!Array.isArray(v.warnings)||v.warnings.length>20||v.warnings.some(w=>typeof w!=='string'||w.length>300)||v.confidence!==undefined&&(!Number.isFinite(v.confidence)||v.confidence<0||v.confidence>1))throw Error('OCR 候選來源資料不合法');
  return {source:v.source,profile:v.profile,identity:v.identity,preprocessing:v.preprocessing,decoder:v.decoder,backend:v.backend,warnings:[...v.warnings],at:v.at,...(v.confidence===undefined?{}:{confidence:v.confidence})};
}
export function cleanOcrCandidates(value:unknown){
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>2)throw Error('每框最多兩份 OCR 候選');
  return value.map(v=>{const result=cleanOcrCandidate(v);if(!result)throw Error('OCR 候選不可空白');return result;});
}
export function withCandidate(region:Region,candidate:OcrCandidate):Region {
  const original=region.ocrCandidates?.[0]??(region.ocr?.source===region.source?region.ocr:undefined)??{source:region.source,profile:'legacy',identity:'unversioned',preprocessing:'unknown',decoder:'unknown',backend:'unknown',warnings:[...region.warnings],at:Date.now()} satisfies OcrCandidate;
  return {...region,ocrCandidates:[original,candidate]};
}
export function applyCandidate(region:Region,candidate:OcrCandidate):Region {
  const changed=region.source!==candidate.source;
  return {...region,source:candidate.source,ocr:candidate,ocrDone:true,needsReview:needsOcrReview(candidate.source),warnings:[...candidate.warnings],...(changed?{translation:'',initialTranslation:undefined}:{})};
}
export function splitRegion(region:Region,axis:'x'|'y',position:number,uuid:()=>string=()=>crypto.randomUUID()):Region[] {
  const start=region[axis],length=axis==='x'?region.width:region.height;
  if(!Number.isFinite(position)||position-start<4||start+length-position<4)throw Error('分割線兩側至少保留 4 像素');
  const child=(rect:Partial<Region>):Region=>({...region,...rect,id:uuid(),source:'',translation:'',initialTranslation:undefined,ocr:undefined,ocrCandidates:undefined,ocrDone:false,needsReview:false,ocrBox:undefined,bubbleBox:undefined,warnings:['手動拆框，請重新辨識']});
  if(axis==='x')return [child({x:position,width:region.x+region.width-position}),child({width:position-region.x})];
  return [child({height:position-region.y}),child({y:position,height:region.y+region.height-position})];
}
