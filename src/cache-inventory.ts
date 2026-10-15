import type {PageData} from './types';
import lock from './model-lock.json';
export interface CacheRecord {cache:string;url:string;bytes:number;measuredAt:number;verified?:boolean}
export const ownedCache=(name:string)=>name==='comic-vision-v1'||name.startsWith('webllm/');
export const recordKey=(cache:string,url:string)=>JSON.stringify([cache,url]);
export function modelGroup(cache:string,url:string){const vision=lock.vision.find(m=>m.files.some(f=>f.url===url));if(vision)return {id:vision.id,version:vision.revision,expected:vision.files.length};const u=new URL(url),llm=lock.llm.find(m=>url.startsWith(m.model)||u.pathname===m.model_lib);if(llm)return {id:llm.model_id,version:llm.revision,expected:undefined};return {id:cache+':'+u.origin+u.pathname.replace(/\/[^/]+$/,''),version:'快取網址所示版本',expected:undefined};}
export async function responseBytes(response:Response,signal?:AbortSignal){
  const reader=response.body?.getReader();if(!reader)return 0;let bytes=0;
  try{while(true){signal?.throwIfAborted();const chunk=await reader.read();if(chunk.done)return bytes;bytes+=chunk.value.byteLength;}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function inventory(){
  const data=await chrome.storage.local.get(null),keys=Object.keys(data).filter(k=>k.startsWith('page:'));
  const pages=await Promise.all(keys.map(async key=>{const p=(data[key]&&typeof data[key]==='object'?data[key]:{}) as Partial<PageData>;return {key,hash:p.hash,title:p.title,chapter:p.chapter,regions:Array.isArray(p.regions)?p.regions.length:0,source:p.sourcePageUrl,pageIndex:p.pageIndex,savedAt:p.savedAt,bytes:await chrome.storage.local.getBytesInUse(key),backend:(()=>{try{return JSON.parse(p.modelKey??'')[1];}catch{return '未記錄';}})()};}));
  const index=(data.cacheSizeIndex??{}) as Record<string,CacheRecord>,models=[];
  for(const name of (await caches.keys()).filter(ownedCache)){const cache=await caches.open(name);for(const request of await cache.keys()){const record=index[recordKey(name,request.url)];models.push({cache:name,url:request.url,...modelGroup(name,request.url),bytes:record?.bytes,measuredAt:record?.measuredAt,verified:record?.verified});}}
  const estimate=await navigator.storage?.estimate?.().catch(()=>undefined);
  return {pages,models,pageBytes:await chrome.storage.local.getBytesInUse(keys),modelBytes:models.reduce((n,r)=>n+(r.bytes??0),0),unmeasured:models.filter(r=>r.bytes===undefined).length,estimate:estimate?{usage:estimate.usage,quota:estimate.quota}:undefined};
}
export async function scanCaches(){
  const {cacheSizeIndex={}}=await chrome.storage.local.get('cacheSizeIndex'),index=cacheSizeIndex as Record<string,CacheRecord>;
  for(const name of (await caches.keys()).filter(ownedCache)){const cache=await caches.open(name);for(const request of await cache.keys()){const response=await cache.match(request);if(!response)continue;const key=recordKey(name,request.url);index[key]={cache:name,url:request.url,bytes:await responseBytes(response),measuredAt:Date.now(),verified:index[key]?.verified};}}
  await chrome.storage.local.set({cacheSizeIndex:index});return inventory();
}
export async function removeCache(selection:{kind:'page'|'pages'|'model'|'models'|'model-group';key?:string;cache?:string;url?:string;group?:string}){
  if(!selection||!['page','pages','model','models','model-group'].includes(selection.kind))throw new Error('快取刪除範圍不合法');
  if(selection.kind==='page'&&!selection.key?.startsWith('page:'))throw new Error('頁面快取索引不合法');
  if(selection.kind==='model'&&(!selection.cache||!ownedCache(selection.cache)||!selection.url))throw new Error('模型快取索引不合法');
  if(selection.kind==='model-group'&&!selection.group)throw new Error('模型群組不合法');
  if(selection.kind==='page'||selection.kind==='pages'){
    const all=await chrome.storage.local.get(null),keys=Object.keys(all).filter(k=>k.startsWith('page:')&&(selection.kind==='pages'||k===selection.key));
    await chrome.storage.local.remove(keys);const {pageKeys=[]}=await chrome.storage.local.get('pageKeys');await chrome.storage.local.set({pageKeys:(pageKeys as string[]).filter(k=>!keys.includes(k))});
  }else{
    const {cacheSizeIndex={}}=await chrome.storage.local.get('cacheSizeIndex'),index=cacheSizeIndex as Record<string,CacheRecord>;
    for(const name of (await caches.keys()).filter(ownedCache)){if(selection.kind==='model'&&selection.cache!==name)continue;const cache=await caches.open(name);for(const request of await cache.keys()){if(selection.kind==='model'&&selection.url!==request.url)continue;if(selection.kind==='model-group'&&selection.group!==modelGroup(name,request.url).id)continue;await cache.delete(request);delete index[recordKey(name,request.url)];}}
    await chrome.storage.local.set({cacheSizeIndex:index});
  }
  return inventory();
}
