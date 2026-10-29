import lock from './model-lock.json';
import type {OcrProfile} from './types';
export interface ModelRef {model:string;file:string}
export interface OcrSpec {encoder:ModelRef;decoder:ModelRef;cross?:ModelRef;vocab:ModelRef;decode:'standard'|'kv';preprocessing:string}
export const preprocessingVersion='canvas-gray-224-v1';
export function ocrSpec(profile:OcrProfile='int8'):OcrSpec {const s=lock.ocrProfiles[profile];return {...s,decode:s.decode==='kv'?'kv':'standard'};}
export function ocrFiles(profile:OcrProfile='int8') {const s=ocrSpec(profile);return [s.encoder,s.decoder,...(s.cross?[s.cross]:[]),s.vocab];}
export function ocrIdentity(profile:OcrProfile='int8') {
  const spec=ocrSpec(profile);
  return JSON.stringify([profile,spec.decode,spec.preprocessing,...ocrFiles(profile).map(ref=>lock.vision.find(m=>m.id===ref.model)!.files.find(f=>f.name===ref.file)!.sha256)]);
}
export function ocrBytes(profile:OcrProfile='int8'){return ocrFiles(profile).reduce((sum,ref)=>sum+lock.vision.find(m=>m.id===ref.model)!.files.find(f=>f.name===ref.file)!.bytes,0);}
