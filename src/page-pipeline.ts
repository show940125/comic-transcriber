import type {Diagnostic,PageData,Region,Settings} from './types';
import {engine} from './runtime';
import {hashBlob,contentSignature,localUrl} from './core';
import {cachePage,loadPage} from './storage';
import {needsOcrReview,ocrReviewWarning} from './ocr-quality';
import {googleWebTranslate} from './google-web';
import {extensionCall,detached,contextAlive} from './extension-context';
import {renderPage,loadFont} from './render';
import {SerialLane,DeferredTranslationError} from './scheduling';
export interface PageSession {blob:Blob;image:HTMLImageElement;regions:Region[];hash:string;modelKey:string;legacyModelKey?:string;config:Settings;cacheScope?:'private';metadata?:Pick<PageData,'sourcePageUrl'|'imageUrl'|'pageIndex'|'refinement'>}
export interface PageHooks {progress?:(d:Diagnostic)=>void;partial?:(regions:Region[])=>void;beforeTranslate?:()=>Promise<void>;canTranslate?:()=>boolean;onFailure?:(error:unknown)=>void;signal?:AbortSignal;ocrOnly?:boolean}
const translationLane=new SerialLane();
export async function loadSession(blob:Blob,config:Settings,signal?:AbortSignal):Promise<PageSession&{dispose:()=>void}>{
  if(blob.size>20*1024*1024||!blob.type.startsWith('image/'))throw new Error('請使用 20 MB 以內的圖片');
  signal?.throwIfAborted();const url=URL.createObjectURL(blob),image=new Image();
  try{image.src=url;await image.decode();signal?.throwIfAborted();if(image.naturalWidth*image.naturalHeight>30_000_000)throw new Error('圖片超過 3000 萬像素，請先裁切');
    const hash=await hashBlob(blob),modelKey=contentSignature(config),cached=await loadPage(hash,modelKey);
    return {blob,image,hash,modelKey,config:{...config},metadata:cached?{sourcePageUrl:cached.sourcePageUrl,imageUrl:cached.imageUrl,pageIndex:cached.pageIndex,refinement:cached.refinement}:undefined,regions:(cached?.regions??[]).map(r=>({...r,bubbleBox:r.bubbleBox??(r.kind==='bubble'?r.ocrBox:undefined),ocrDone:r.ocrDone??(!!r.source.trim()||r.warnings.some(w=>/疑似無文字|缺少日文字元/.test(w)))})),dispose:()=>{URL.revokeObjectURL(url);image.src='';}};
  }catch(error){URL.revokeObjectURL(url);throw error;}
}
export function sessionData(session:PageSession):PageData{
  const {image,config}=session;session.modelKey=session.legacyModelKey??contentSignature(config,session.cacheScope);
  const page:PageData={schema:1,hash:session.hash,width:image.naturalWidth,height:image.naturalHeight,regions:structuredClone(session.regions),title:config.title,chapter:config.chapter,glossary:config.glossary,summary:session.regions.filter(r=>r.translation).map(r=>r.translation).join('\n').slice(0,1500),modelKey:session.modelKey};
  Object.assign(page,session.metadata,{savedAt:Date.now()});return page;
}
export async function saveSession(session:PageSession){await cachePage(sessionData(session));}
export async function detectSession(session:PageSession,hooks:PageHooks={}){
  session.regions=await engine({op:'detect',image:session.blob,width:session.image.naturalWidth,height:session.image.naturalHeight},hooks.progress,hooks.signal);await saveSession(session);
}
export async function ocrSession(session:PageSession,hooks:PageHooks={}){
  const conf=session.config;
  if(conf.localOcr){const output=await engine({op:'local-ocr',image:session.blob,regions:session.regions,endpoint:localUrl(conf.ocrEndpoint)},hooks.progress,hooks.signal);
    if(!Array.isArray(output.regions)||output.regions.length!==session.regions.length||output.regions.some((r:any,i:number)=>r.id!==session.regions[i].id||typeof r.source!=='string'))throw new Error('本機 OCR 結果格式錯誤');
    session.regions=session.regions.map((r,i)=>({...r,source:output.regions[i].source,translation:'',ocrDone:true,needsReview:needsOcrReview(output.regions[i].source),warnings:[...(output.regions[i].warnings??r.warnings),...(needsOcrReview(output.regions[i].source)?[ocrReviewWarning]:[])]}));
    hooks.progress?.({stage:'ocr',message:'本機 OCR 完成',backend:output.backend,ms:output.ms});
  }else session.regions=await engine({op:'ocr',image:session.blob,regions:session.regions,provider:conf.ocrProvider,profile:conf.ocrProfile},hooks.progress,hooks.signal);
  session.legacyModelKey=undefined;session.regions=session.regions.map(r=>({...r,initialTranslation:undefined}));if(session.metadata)delete session.metadata.refinement;
  await saveSession(session);
}
export const googleProxy:typeof fetch=async(input,init)=>{
  init?.signal?.throwIfAborted();const id=crypto.randomUUID(),source=new URL(String(input)).searchParams.get('q');
  const cancel=()=>{if(contextAlive())detached(()=>chrome.runtime.sendMessage({channel:'cancel',id}));};init?.signal?.addEventListener('abort',cancel,{once:true});
  try{const result=await extensionCall(()=>chrome.runtime.sendMessage({channel:'google-text',id,source}));init?.signal?.throwIfAborted();if(!result?.ok)throw new Error(result?.error??'Google 翻譯請求未回應');return new Response(JSON.stringify(result.data),{status:result.status,headers:{'content-type':'application/json'}});
  }finally{init?.signal?.removeEventListener('abort',cancel);}
};
export async function translateSession(session:PageSession,hooks:PageHooks={}){
  return translationLane.run(async()=>{
    if(hooks.canTranslate&&!hooks.canTranslate())throw new DeferredTranslationError();
    try{
    const conf=session.config;
    if(!session.regions.some(r=>r.source.trim()&&!r.needsReview))throw new Error('請先 OCR，並核對原文辨識警示');
    const local=async()=>{const gpu=conf.backend==='webllm'?await engine({op:'probe'},hooks.progress,hooks.signal):undefined;const modelId=conf.backend==='webllm'?`Qwen3.5-${conf.model==='2b'?'2B':'0.8B'}-q4f${gpu?.f16?'16':'32'}_1-MLC`:'';return engine({op:'translate',regions:session.regions,settings:conf,modelId},hooks.progress,hooks.signal);};
    if(conf.backend==='google-web'){
      try{session.regions=await googleWebTranslate(session.regions,hooks.progress,hooks.signal,googleProxy,{spacingMs:0,onPartial:async regions=>{session.regions=regions;await saveSession(session);hooks.partial?.(regions);}});}
      catch(error){if(!conf.localFallback||hooks.signal?.aborted)throw error;hooks.progress?.({stage:'translating',message:'Google 來源失敗，使用已啟用的本機備援',backend:'local-http'});session.regions=await engine({op:'translate',regions:session.regions,settings:{...conf,backend:'local'},modelId:''},hooks.progress,hooks.signal);}
    }else if(conf.backend==='gemini-web')session.regions=await engineChrome(session.regions,hooks,{channel:'gemini-translate',settings:conf,pageHash:session.hash});
    else if(conf.backend==='chrome')session.regions=await engineChrome(session.regions,hooks);
    else session.regions=await local();
    await saveSession(session);hooks.partial?.(session.regions);
    }catch(error){if(session.config.backend==='gemini-web'){await saveSession(session);hooks.partial?.(session.regions);}hooks.onFailure?.(error);throw error;}
  },hooks.signal);
}
async function engineChrome(regions:Region[],hooks:PageHooks,extra:Record<string,unknown>={channel:'native-translate'}){
  const inputFingerprint=JSON.stringify(regions.map(r=>[r.id,r.source]));
  const id=crypto.randomUUID(),listener=(message:any)=>{if(message.channel==='progress'&&message.id===id)hooks.progress?.(message.diagnostic);};
  await extensionCall(()=>chrome.runtime.onMessage.addListener(listener));
  const cancel=()=>{if(contextAlive())detached(()=>chrome.runtime.sendMessage({channel:'cancel',id}));};hooks.signal?.addEventListener('abort',cancel,{once:true});
  try{const result=await extensionCall(()=>chrome.runtime.sendMessage({id,regions,...extra}));hooks.signal?.throwIfAborted();const output=result?.ok?result.result:result?.partial;if(output){if(JSON.stringify(regions.map(r=>[r.id,r.source]))!==inputFingerprint||!Array.isArray(output)||JSON.stringify(output.map((r:Region)=>[r.id,r.source]))!==inputFingerprint)throw new Error('原文或區域已改變，舊翻譯回覆已拒絕套用');if(!result?.ok)regions.splice(0,regions.length,...output);}if(!result?.ok)throw new Error(result?.error??'翻譯來源未回應');return result.result as Region[];
  }finally{hooks.signal?.removeEventListener('abort',cancel);if(contextAlive())detached(()=>chrome.runtime.onMessage.removeListener(listener));}
}
export async function processSession(session:PageSession,hooks:PageHooks={}){
  try{
  if(!session.regions.length)await detectSession(session,hooks);
  if(session.regions.some(r=>!r.ocrDone&&!r.source.trim()))await ocrSession(session,hooks);
  if(hooks.ocrOnly)return;
  await hooks.beforeTranslate?.();
  if(session.regions.some(r=>r.source.trim()&&!r.needsReview&&!r.translation.trim()))await translateSession(session,hooks);
  if(session.regions.some(r=>r.needsReview))hooks.progress?.({stage:'review',message:'部分原文需核對，其餘譯文已保留'});
  }catch(error){if(!(error instanceof DeferredTranslationError))hooks.onFailure?.(error);throw error;}
}
export async function encodeSession(session:PageSession,throughBackground=true){
  await loadFont(throughBackground);
  session.regions=session.regions.map(r=>({...r,warnings:r.warnings.filter(w=>!/^原文清除需校正|^中文空間不足/.test(w))}));
  const canvas=renderPage(session.image,session.regions,false,(id,message)=>{const region=session.regions.find(r=>r.id===id);if(region&&!region.warnings.includes(message))region.warnings.push(message);});
  try{const png=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('PNG 編碼失敗')),'image/png'));await saveSession(session);return new Uint8Array(await png.arrayBuffer());}
  finally{canvas.width=canvas.height=0;}
}
