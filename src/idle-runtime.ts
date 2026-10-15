/** Runs in the offscreen document, so worker suspension cannot lose the timer. */
export class IdleRuntime {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private busy=0;private disposed=false;
  constructor(private expire:()=>void,private delay=60_000){}
  activity(count:number){if(this.disposed)return;this.busy=Math.max(0,count);this.clear();if(!this.busy)this.timer=setTimeout(()=>{this.timer=undefined;if(!this.disposed&&!this.busy)this.expire();},this.delay);}
  dispose(){this.disposed=true;this.clear();}
  private clear(){if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;}
}
export function resolveThreads(requested:'auto'|1|2|4,isolated:boolean,shared:boolean){
  const wanted=requested===2||requested===4?requested:1;
  return {requested,threads:isolated&&shared?wanted:1,reason:wanted>1&&(!isolated||!shared)?'此推論文件未提供跨來源隔離或 SharedArrayBuffer，使用單執行緒':undefined};
}
