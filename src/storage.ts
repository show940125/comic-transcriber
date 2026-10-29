import { defaults, type Settings, type PageData } from './types';
import { compatiblePageKey,contentSignature,translationInstructions,translationInstructionsLimit } from './core';
import {extensionCall} from './extension-context';
import {specificSites} from './site-access';
export async function settings(): Promise<Settings> {
  const result = await extensionCall(()=>chrome.storage.local.get('settings'));
  const value={ ...defaults, ...(result.settings as Partial<Settings> | undefined) };
  value.pageConcurrency=value.pageConcurrency===1?1:2;
  value.ocrProfile=value.ocrProfile==='fp32'?'fp32':'int8';
  value.chapterMode=value.chapterMode==='gemini-direct'?'gemini-direct':'standard';
  value.translationInstructions=translationInstructions(value);
  value.autoSites=specificSites(value.autoSites);
  // Gemini now performs the optional whole-chapter second pass.
  if(value.backend==='gemini-web')value.backend='google-web';return value;
}
export async function saveSettings(value: Settings) { if(typeof value.translationInstructions!=='string'||value.translationInstructions.length>translationInstructionsLimit)throw new Error('漫畫專屬翻譯指示最多 3,000 字');await extensionCall(()=>chrome.storage.local.set({ settings: {...value,translationInstructions:translationInstructions(value)} })); }
let writeTail:Promise<unknown>=Promise.resolve();
export function storageWrite<T>(work:()=>Promise<T>):Promise<T>{const next=writeTail.catch(()=>{}).then(work);writeTail=next;return next;}
export async function cachePage(page: PageData) {
  if(chrome.runtime?.id){const response=await extensionCall(()=>chrome.runtime.sendMessage({channel:'cache-page',page}));if(!response?.ok)throw new Error(response?.error??'頁面快取儲存失敗');return;}
  return cachePageDirect(page);
}
// The service worker owns one cache-index writer across all tabs/documents.
export function cachePageDirect(page:PageData):Promise<void>{
  return storageWrite(()=>extensionCall(()=>writePage(page)));
}
async function writePage(page:PageData) {
  const key = `page:${page.hash}:${page.modelKey}`;
  const old=(await chrome.storage.local.get(key))[key] as PageData|undefined;
  for(const field of ['sourcePageUrl','imageUrl','pageIndex','savedAt','lastAccessAt'] as const)if(page[field]===undefined&&old?.[field]!==undefined)Object.assign(page,{[field]:old[field]});
  await chrome.storage.local.set({ [key]: page });
  const { pageKeys = [] } = await chrome.storage.local.get<{ pageKeys: string[] }>('pageKeys');
  const prefix=`page:${page.hash}:`,aliases=pageKeys.filter(k=>k!==key&&k.startsWith(prefix)&&compatiblePageKey(k.slice(prefix.length),page.modelKey));
  const keys = [key, ...pageKeys.filter((k: string) => k !== key&&!aliases.includes(k))];
  await chrome.storage.local.set({ pageKeys: keys.slice(0, 30) });
  if (aliases.length||keys.length>30) await chrome.storage.local.remove([...aliases,...keys.slice(30)]);
}
export async function loadPage(hash: string, modelKey: string): Promise<PageData | undefined> {
  return extensionCall(()=>readPage(hash,modelKey));
}
export async function legacyPages(hash:string,privateScope:boolean):Promise<PageData[]> {
  const {pageKeys=[]}=await extensionCall(()=>chrome.storage.local.get<{pageKeys:string[]}>('pageKeys'));
  const keys=pageKeys.filter(k=>k.startsWith(`page:${hash}:`)).filter(k=>{
    try{let key=JSON.parse(k.slice(`page:${hash}:`.length));const privateKey=key[0]==='private-reader-v1';if(privateKey)key=JSON.parse(key[1]);return privateKey===privateScope&&key[0]!=='pipeline-4-ocr-identity';}catch{return false;}
  });
  const values=keys.length?await extensionCall(()=>chrome.storage.local.get(keys)):{};
  return keys.map(k=>values[k] as PageData).filter(p=>p?.schema===1&&p.hash===hash);
}
// Capture the bounded page cache before direct-mode writes rotate its 30 keys.
export async function ocrReusePages(config:Settings):Promise<Map<string,PageData>>{
  const modelKey=contentSignature({...config,backend:'google-web'});
  const {pageKeys=[]}=await extensionCall(()=>chrome.storage.local.get<{pageKeys:string[]}>('pageKeys'));
  const keys=pageKeys.slice(0,30),stored=keys.length?await extensionCall(()=>chrome.storage.local.get(keys)):{};
  return new Map(keys.map(k=>stored[k] as PageData).filter(p=>p?.schema===1&&compatiblePageKey(p.modelKey,modelKey)).map(p=>[p.hash,p]));
}
async function readPage(hash:string,modelKey:string):Promise<PageData|undefined>{
  const key = `page:${hash}:${modelKey}`;
  const exact=(await chrome.storage.local.get(key))[key] as PageData|undefined;if(exact)return exact;
  const {pageKeys=[]}=await chrome.storage.local.get<{pageKeys:string[]}>('pageKeys'),prefix=`page:${hash}:`;
  const candidates=pageKeys.filter(k=>k.startsWith(prefix)&&compatiblePageKey(k.slice(prefix.length),modelKey));
  if(!candidates.length)return;
  const stored=await chrome.storage.local.get(candidates);
  for(const candidate of candidates){const page=stored[candidate] as PageData|undefined;if(page?.schema===1&&page.hash===hash)return {...page,modelKey};}
}
