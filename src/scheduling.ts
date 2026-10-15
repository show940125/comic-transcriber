export class SerialLane {
  private tail:Promise<unknown>=Promise.resolve();
  run<T>(work:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    const task=this.tail.catch(()=>{}).then(()=>{signal?.throwIfAborted();return work();});this.tail=task;return task;
  }
}
/** OCR may finish out of order; context-sensitive translation waits by page. */
export class OrderedTurns {
  private current=0;private done=new Set<number>();private listeners=new Set<()=>void>();
  wait(index:number,signal?:AbortSignal):Promise<void>{signal?.throwIfAborted();if(index<=this.current)return Promise.resolve();return new Promise((resolve,reject)=>{const clean=()=>{this.listeners.delete(check);signal?.removeEventListener('abort',abort);};const check=()=>{if(index<=this.current){clean();resolve();}};const abort=()=>{clean();reject(signal?.reason);};this.listeners.add(check);signal?.addEventListener('abort',abort,{once:true});});}
  finish(index:number){this.done.add(index);while(this.done.delete(this.current))this.current++;for(const listener of [...this.listeners])listener();}
}
export interface PoolControl { stopped:()=>boolean; signal?:AbortSignal; failed?:()=>boolean }
// One pool serves visible-page and chapter requests. Errors stop admissions;
// already-started tasks may finish OCR/cache work before settling.
export async function runPool<T>(items:T[],limit:number,work:(item:T,index:number)=>Promise<void>,control:PoolControl):Promise<void>{
  let next=0,failure:unknown;
  const consume=async()=>{
    while(next<items.length&&!failure&&!control.stopped()&&!control.failed?.()&&!control.signal?.aborted){
      const index=next++;
      try{await work(items[index],index);}catch(error){failure??=error;}
    }
  };
  await Promise.all(Array.from({length:Math.max(1,Math.min(2,limit))},consume));
  control.signal?.throwIfAborted();if(failure)throw failure;
}
export class DeferredTranslationError extends Error {constructor(){super('另一張圖片翻譯失敗；本張 OCR 已保存，續翻時可恢復');this.name='DeferredTranslationError';}}
export class ResourceSlots {
  private active=new Map<string,number>();
  private waiting:Array<{id:string;owner:number;resolve:()=>void;reject:(error:unknown)=>void;promise:Promise<void>}>=[];
  constructor(private limit=2){}
  acquire(id:string,owner:number):Promise<void>{
    if(this.active.has(id))return Promise.resolve();const prior=this.waiting.find(w=>w.id===id);if(prior)return prior.promise;
    let resolve!:()=>void,reject!:(error:unknown)=>void;const promise=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});
    this.waiting.push({id,owner,resolve,reject,promise});this.drain();return promise;
  }
  release(id:string){this.active.delete(id);const item=this.waiting.find(w=>w.id===id);if(item){this.waiting=this.waiting.filter(w=>w!==item);item.reject(new DOMException('圖片任務已取消','AbortError'));}this.drain();}
  cancelWaiting(id:string){const item=this.waiting.find(w=>w.id===id);if(item){this.waiting=this.waiting.filter(w=>w!==item);item.reject(new DOMException('圖片任務已取消','AbortError'));}}
  releaseOwner(owner:number){for(const id of [...this.active].filter(([,value])=>value===owner).map(([id])=>id))this.active.delete(id);for(const item of this.waiting.filter(w=>w.owner===owner)){this.waiting=this.waiting.filter(w=>w!==item);item.reject(new DOMException('漫畫分頁已關閉','AbortError'));}this.drain();}
  private drain(){while(this.active.size<this.limit&&this.waiting.length){const next=this.waiting.shift()!;this.active.set(next.id,next.owner);next.resolve();}}
}
