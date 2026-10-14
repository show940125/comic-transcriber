export class ExtensionContextError extends Error {
  constructor(){super('墨譯已更新，請重新整理漫畫頁後續翻；完成的圖片已保留');this.name='ExtensionContextError';}
}
let invalidated=false;
const listeners=new Set<()=>void>();
export const contextInvalidated=(error:unknown)=>error instanceof ExtensionContextError||/Extension context invalidated/i.test(error instanceof Error?error.message:String(error));
export function invalidateContext(){if(invalidated)return;invalidated=true;for(const listener of [...listeners]){try{listener();}catch{}}listeners.clear();}
export function onContextInvalidated(listener:()=>void){if(invalidated)listener();else listeners.add(listener);return ()=>{listeners.delete(listener);};}
export function contextAlive(){return !invalidated;}
export async function extensionCall<T>(work:()=>T|Promise<T>):Promise<T>{
  if(invalidated)throw new ExtensionContextError();
  try{return await work();}catch(error){if(contextInvalidated(error)){invalidateContext();throw new ExtensionContextError();}throw error;}
}
// Own every fire-and-forget promise, including synchronous API exceptions.
export function detached(work:()=>unknown|Promise<unknown>,failure?:(error:unknown)=>void){
  void extensionCall(work).catch(error=>{if(contextInvalidated(error))return;if(failure)failure(error);else console.warn('墨譯',error);});
}
// Reading the ID does not send a message. A stale document can retire itself
// before a click/observer attempts an API call after extension reload.
export function watchExtensionContext(){
  const timer=setInterval(()=>{try{if(!chrome.runtime?.id)invalidateContext();}catch(error){if(contextInvalidated(error))invalidateContext();else console.warn('墨譯生命週期',error);}},1000);
  const stop=()=>{clearInterval(timer);unsubscribe();};const unsubscribe=onContextInvalidated(()=>clearInterval(timer));return stop;
}
