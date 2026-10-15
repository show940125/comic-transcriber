import { defaults, type Settings, type PageData } from './types';
import { compatiblePageKey } from './core';
import {extensionCall} from './extension-context';
export async function settings(): Promise<Settings> {
  const result = await extensionCall(()=>chrome.storage.local.get('settings'));
  const value={ ...defaults, ...(result.settings as Partial<Settings> | undefined) };
  value.pageConcurrency=value.pageConcurrency===1?1:2;return value;
}
export async function saveSettings(value: Settings) { await extensionCall(()=>chrome.storage.local.set({ settings: value })); }
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
async function readPage(hash:string,modelKey:string):Promise<PageData|undefined>{
  const key = `page:${hash}:${modelKey}`;
  const exact=(await chrome.storage.local.get(key))[key] as PageData|undefined;if(exact)return exact;
  const {pageKeys=[]}=await chrome.storage.local.get<{pageKeys:string[]}>('pageKeys'),prefix=`page:${hash}:`;
  const candidates=pageKeys.filter(k=>k.startsWith(prefix)&&compatiblePageKey(k.slice(prefix.length),modelKey));
  if(!candidates.length)return;
  const stored=await chrome.storage.local.get(candidates);
  for(const candidate of candidates){const page=stored[candidate] as PageData|undefined;if(page?.schema===1&&page.hash===hash)return {...page,modelKey};}
}
