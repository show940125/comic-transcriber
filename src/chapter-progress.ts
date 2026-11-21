export type ChapterPhase = 'prepare' | 'ocr' | 'translate' | 'render' | 'gemini' | 'reflow';
export type ChapterEvent = {phase:ChapterPhase; status:'running'|'done'|'reused'};
export type ChapterOutcome = 'running'|'stopping'|'done'|'stopped'|'cancelled'|'error'|'unknown';
export type ChapterMode = 'standard'|'direct'|'refine';
export type ChapterStep = {
  id:ChapterPhase; label:string; status:'pending'|'running'|'done'|'held'|'error';
  summary:string; detail:string[];
};

export class ChapterProgress {
  private readonly phases = new Map<ChapterPhase,Map<number,{status:ChapterEvent['status'];detail:string}>>();
  private refining = false;
  private failed?: ChapterPhase;
  outcome:ChapterOutcome = 'running';
  readonly started = performance.now();
  ended?:number;

  constructor(readonly mode:ChapterMode, readonly total:number){}

  refinement(){this.refining = true;}

  update(event:ChapterEvent, detail:string, index?:number){
    if(this.ended!==undefined || index!==undefined&&(!Number.isInteger(index)||index<0||index>=this.total))return;
    const row = this.phases.get(event.phase)??new Map<number,{status:ChapterEvent['status'];detail:string}>();
    this.phases.set(event.phase,row);
    const key = index??-1;
    const previous = row.get(key);
    if(!previous||previous.status==='running')row.set(key,{status:event.status,detail});
  }

  fail(phase:ChapterPhase){this.failed??=phase;}

  isComplete(phase:ChapterPhase){
    return this.total>0&&[...(this.phases.get(phase)?.values()??[])].filter(item=>item.status!=='running').length===this.total;
  }

  finish(outcome:ChapterOutcome){
    this.outcome = outcome;
    this.ended = performance.now();
  }

  rows():ChapterStep[]{
    const phases: [ChapterPhase,string][] = [
      ['prepare',this.mode==='refine'?'核對已存初譯':'準備圖片']
    ];
    if(this.mode!=='refine')phases.push(['ocr',this.mode==='direct'?'收齊日文 OCR':'偵測與 OCR']);
    if(this.mode==='standard')phases.push(['translate','逐頁翻譯'],['render','嵌字與套用']);
    if(this.mode!=='standard'||this.refining)phases.push(['gemini',this.mode==='direct'?'Gemini 整章直譯':'整章 Gemini 校正'],['reflow','重排與套用']);
    return phases.map(([id,label])=>{
      const entries=[...(this.phases.get(id)??[])];
      const active=entries.filter(([,e])=>e.status==='running');
      const finished=entries.filter(([,e])=>e.status!=='running');
      const whole=id==='gemini'||id==='prepare'&&this.mode==='refine';
      const done=finished.length===(whole?1:this.total)&&(whole||this.total>0);
      const reused=finished.filter(([,e])=>e.status==='reused').length;
      const activeRun=this.outcome==='running'||this.outcome==='stopping';
      const status=done?'done':this.failed===id&&this.outcome==='error'?'error':active.length?activeRun?'running':'held':'pending';
      const summary=id==='gemini'
        ? done?reused?'沿用已核對回覆':'回覆已核對':active.length?this.outcome==='unknown'?'待確認':activeRun?'等待回覆':'已中止':'尚未送出'
        : whole?done?'已核對':'待核對':`${finished.length}／${this.total} 張${reused?` · 沿用 ${reused}`:''}`;
      const detail=[...active.sort((a,b)=>a[0]-b[0]),...finished.reverse().slice(0,6)].map(([index,e])=>
        index===-1?e.detail:`第 ${index+1} 張 · ${e.detail}`);
      return {id,label,status,summary,detail};
    });
  }
}
