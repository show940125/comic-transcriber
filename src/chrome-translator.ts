import type { Region, Diagnostic } from './types';
import { traditional } from './language';
let ready:any,pending:Promise<any>|undefined,creationSignal:AbortSignal|undefined,generation=0,initialization:AbortController|undefined;
export async function chromeTranslatorAvailability():Promise<{status:'unavailable'|'downloadable'|'downloading'|'available';reason?:string}>{
  const api=(globalThis as any).Translator;if(!api)return {status:'unavailable',reason:'此文件未提供 Chrome Translator API'};
  try{const status=await api.availability({sourceLanguage:'ja',targetLanguage:'zh-Hant'});return ['unavailable','downloadable','downloading','available'].includes(status)?{status}:{status:'unavailable',reason:'Chrome 回傳未知語言包狀態'};}
  catch(error){return {status:'unavailable',reason:error instanceof Error?error.message:String(error)};}
}
export function disposeChromeTranslator(){generation++;initialization?.abort();initialization=undefined;try{ready?.destroy();}catch{}ready=undefined;pending=undefined;creationSignal=undefined;}
export function prepareChromeTranslator(report:(d:Diagnostic)=>void=()=>{},signal?:AbortSignal):Promise<any>{
  signal?.throwIfAborted();if(creationSignal?.aborted)disposeChromeTranslator();if(ready)return Promise.resolve(ready);if(pending)return pending;
  const api=(globalThis as any).Translator;if(!api)return Promise.reject(new Error('此瀏覽器沒有 Translator API，請在設定選 Google 免費網頁翻譯或本機服務。'));
  report({stage:'loading',message:'準備 Chrome 本機翻譯語言包',backend:'chrome-translator/local',model:'Chrome language pack'});
  // create() starts synchronously from the user's click, before OCR awaits can
  // consume transient activation. The native translator remains in this document.
  const mine=generation,controller=new AbortController();initialization=controller;creationSignal=signal;
  const timer=setTimeout(()=>controller.abort(new DOMException('語言包初始化逾時，可重試或改用 Google 免費網頁翻譯','TimeoutError')),180000);
  const createSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const cleanup=()=>{clearTimeout(timer);if(initialization===controller)initialization=undefined;};
  let created:Promise<any>;try{created=api.create({sourceLanguage:'ja',targetLanguage:'zh-Hant',signal:createSignal,monitor(m:any){m.addEventListener('downloadprogress',(e:any)=>report({stage:'loading',message:`Chrome 語言包下載 ${Math.round(e.loaded*100)}%`,backend:'chrome-translator/local'}));}});}catch(error){cleanup();return Promise.reject(error);}
  pending=created.then((value:any)=>{cleanup();if(mine!==generation||signal?.aborted){value.destroy();throw new DOMException('初始化已取消','AbortError');}ready=value;pending=undefined;return value;},(error:any)=>{cleanup();if(mine===generation)pending=undefined;throw error;});return pending!;
}
export async function chromeTranslate(regions: Region[], report: (d: Diagnostic) => void = () => {}, signal?: AbortSignal): Promise<Region[]> {
  signal?.throwIfAborted();const started=performance.now();
  const translator=await prepareChromeTranslator(report,signal);
  const stop=()=>disposeChromeTranslator();signal?.addEventListener('abort',stop,{once:true});
  try {
    const output = structuredClone(regions);
    for (const [i,r] of output.entries()) if (r.source.trim()&&!r.needsReview) {signal?.throwIfAborted();report({stage:'translating',message:`Chrome 本機翻譯 ${i+1}/${output.length}`,backend:'chrome-translator/local',model:'Chrome language pack'});r.translation = traditional(await translator.translate(r.source));}
    signal?.throwIfAborted();report({stage:'complete',message:'Chrome 本機翻譯完成',backend:'chrome-translator/local',model:'Chrome language pack',ms:performance.now()-started});
    return output;
  } finally { signal?.removeEventListener('abort',stop); }
}
