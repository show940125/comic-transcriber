import { defaults, type Settings, type PageData } from './types';
import { compatiblePageKey } from './core';
export async function settings(): Promise<Settings> {
  const result = await chrome.storage.local.get('settings');
  return { ...defaults, ...(result.settings as Partial<Settings> | undefined) };
}
export async function saveSettings(value: Settings) { await chrome.storage.local.set({ settings: value }); }
export async function cachePage(page: PageData) {
  const key = `page:${page.hash}:${page.modelKey}`;
  await chrome.storage.local.set({ [key]: page });
  const { pageKeys = [] } = await chrome.storage.local.get<{ pageKeys: string[] }>('pageKeys');
  const prefix=`page:${page.hash}:`,aliases=pageKeys.filter(k=>k!==key&&k.startsWith(prefix)&&compatiblePageKey(k.slice(prefix.length),page.modelKey));
  const keys = [key, ...pageKeys.filter((k: string) => k !== key&&!aliases.includes(k))];
  await chrome.storage.local.set({ pageKeys: keys.slice(0, 30) });
  if (aliases.length||keys.length>30) await chrome.storage.local.remove([...aliases,...keys.slice(30)]);
}
export async function loadPage(hash: string, modelKey: string): Promise<PageData | undefined> {
  const key = `page:${hash}:${modelKey}`;
  const exact=(await chrome.storage.local.get(key))[key] as PageData|undefined;if(exact)return exact;
  const {pageKeys=[]}=await chrome.storage.local.get<{pageKeys:string[]}>('pageKeys'),prefix=`page:${hash}:`;
  const candidates=pageKeys.filter(k=>k.startsWith(prefix)&&compatiblePageKey(k.slice(prefix.length),modelKey));
  if(!candidates.length)return;
  const stored=await chrome.storage.local.get(candidates);
  for(const candidate of candidates){const page=stored[candidate] as PageData|undefined;if(page?.schema===1&&page.hash===hash)return {...page,modelKey};}
}
