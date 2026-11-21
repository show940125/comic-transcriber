<script lang="ts">
  import {onMount,tick} from 'svelte';
  import {detached,extensionCall} from './extension-context';
  import type {Diagnostic,Settings} from './types';
  import {defaults} from './types';
  import {settings} from './storage';
  import {ChapterRefinementError} from './chapter-refinement';

  type Mode=NonNullable<Settings['chapterMode']>;
  type Activity={total:number;readable:number;recognized:number;directReady:number;standardReady:number;googleReady:number;directRendered:number;review:number};
  let {getImages,getActivity,runChapter,refineChapter,onRunning,openChapter,toggleOriginal}:{
    getImages:()=>HTMLImageElement[];
    getActivity:(images:HTMLImageElement[],config:Settings)=>Activity;
    runChapter:(images:HTMLImageElement[],progress:(d:Diagnostic)=>void,complete:()=>void,stopped:()=>boolean,signal:AbortSignal,ocrOnly?:boolean)=>Promise<void>;
    refineChapter:(images:HTMLImageElement[],progress:(d:Diagnostic)=>void,signal:AbortSignal,direct?:boolean)=>Promise<void>;
    onRunning:(running:boolean)=>void;
    openChapter:(opener:HTMLElement)=>void;
    toggleOriginal:()=>void;
  }=$props();
  let config=$state<Settings>({...defaults}),tabMode=$state<Mode>(),collapsed=$state(false),modeLoaded=$state(false);
  let mode=$derived(tabMode??config.chapterMode??'standard'),direct=$derived(mode==='gemini-direct');
  let readiness=$state<'checking'|'ready'|'permission'|'validation'|'unavailable'>('checking');
  let running=$state(false),stopped=$state(false),refining=$state(false),changingMode=$state(false);
  let detail=$state(''),failure=$state(''),unknownMode=$state<Mode>(),refined=$state(false);
  let jobs=$state<Record<string,{pageIndex:number;message:string}>>({});
  let counts=$state<Activity>({total:0,readable:0,recognized:0,directReady:0,standardReady:0,googleReady:0,directRendered:0,review:0});
  let aborter:AbortController|undefined,releaseAfter=false,refreshRequest=0;
  let orb=$state<HTMLButtonElement>(),collapseButton=$state<HTMLButtonElement>();
  const canRefine=$derived(config.backend==='google-web'&&counts.total>0&&counts.googleReady===counts.total);
  const canRefineNow=$derived(canRefine&&readiness==='ready'&&unknownMode!=='standard');
  const readyMessage=$derived(readiness==='permission'?'請到設定授權 Gemini 網站。':readiness==='validation'?'請到設定準備 Gemini。':readiness==='checking'?'正在確認 Gemini 是否就緒…':'無法確認 Gemini 狀態，請到設定查看。');
  const directComplete=$derived(counts.total>0&&counts.directRendered===counts.total);
  const primaryRun=$derived(direct?(counts.directReady?'繼續整章直譯':'翻譯本章'):(counts.standardReady<counts.total&&(counts.standardReady>0||counts.recognized>0)?'繼續翻譯':'翻譯本章'));

  export function refresh(){
    const next=getActivity(getImages(),$state.snapshot(config));
    if(Object.keys(next).some(key=>next[key as keyof Activity]!==counts[key as keyof Activity]))counts=next;
  }
  export function showError(error:unknown){failure=error instanceof Error?error.message:String(error);}
  async function checkSettings(){
    const request=++refreshRequest;
    const [next,status]=await Promise.all([settings(),extensionCall(()=>chrome.runtime.sendMessage({channel:'gemini-status'}))]);
    if(request!==refreshRequest)return;
    config=next;
    readiness=status?.ok?status.result.ready?'ready':status.result.permission?'validation':'permission':'unavailable';
    refresh();
  }
  onMount(()=>{
    const load=()=>detached(checkSettings,()=>{readiness='unavailable';});
    load();
    detached(async()=>{
      const state=await extensionCall(()=>chrome.runtime.sendMessage({channel:'tab-tools-state'}));
      tabMode=state?.chapterMode;modeLoaded=true;
      collapsed=(await chrome.storage.local.get('dockCollapsed')).dockCollapsed===true;
    },error=>{modeLoaded=true;showError(error);});
    const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{
      if(area!=='local')return;
      if(changes.settings||changes.geminiValidation||changes.geminiValidationProgress)load();
      if(changes.geminiUnknown&&Object.keys(changes.geminiUnknown.newValue??{}).length===0&&unknownMode){
        unknownMode=undefined;failure='';detail='鎖定已解除，可從目前進度繼續。';
      }
    };
    const pause=()=>{stopped=true;releaseAfter=running;detail=running?'正在完成已開始的工作，之後釋放模型。':'模型已安排釋放，譯圖保留。';};
    addEventListener('focus',load);
    addEventListener('comic-pause',pause);
    chrome.storage.onChanged.addListener(changed);
    chrome.permissions?.onAdded.addListener(load);
    chrome.permissions?.onRemoved.addListener(load);
    return ()=>{
      aborter?.abort();removeEventListener('focus',load);removeEventListener('comic-pause',pause);
      chrome.storage.onChanged.removeListener(changed);
      chrome.permissions?.onAdded.removeListener(load);chrome.permissions?.onRemoved.removeListener(load);
    };
  });
  async function changeMode(value:Mode){
    if(changingMode||running||value===mode)return;
    changingMode=true;failure='';
    try{
      const result=await extensionCall(()=>chrome.runtime.sendMessage({channel:'tab-chapter-mode',mode:value}));
      if(!result?.ok)throw new Error(result?.error??'分頁模式未儲存');
      tabMode=value;detail='已切換此分頁的模式。';refined=false;
    }catch(error){failure=error instanceof Error?error.message:String(error);}
    finally{changingMode=false;refresh();}
  }
  async function collapse(value:boolean,button:HTMLElement){
    const rect=button.getBoundingClientRect();collapsed=value;
    button.dispatchEvent(new CustomEvent('comic-dock-anchor',{bubbles:true,composed:true,detail:{mode:value?'collapsed':'expanded',x:rect.left+rect.width/2,y:rect.top+rect.height/2}}));
    detached(()=>chrome.storage.local.set({dockCollapsed:value}));
    await tick();(value?orb:collapseButton)?.focus({preventScroll:true});
  }
  function openSettings(section:'gemini'|'gemini-diagnostics'){
    detached(async()=>{
      const result=await extensionCall(()=>chrome.runtime.sendMessage({channel:'open-options',section}));
      if(!result?.ok)throw new Error(result?.error??'無法開啟設定');
    },error=>{failure=error instanceof Error?error.message:String(error);});
  }
  function progress(d:Diagnostic){
    detail=d.message;
    if(d.jobId&&d.pageIndex!==undefined){
      const next={...jobs};
      if(['complete','error','cancelled'].includes(d.stage))delete next[d.jobId];
      else next[d.jobId]={pageIndex:d.pageIndex,message:d.message};
      jobs=next;
    }
    refresh();
  }
  function begin(){
    running=true;stopped=false;refined=false;failure='';jobs={};
    onRunning(true);aborter=new AbortController();return aborter.signal;
  }
  function finish(){
    refresh();running=false;refining=false;jobs={};onRunning(false);
    if(releaseAfter){releaseAfter=false;detached(()=>chrome.runtime.sendMessage({channel:'runtime-release'}));}
  }
  function reportFailure(error:unknown,signal:AbortSignal,usedMode:Mode,gemini:boolean){
    if(error instanceof ChapterRefinementError&&error.state==='unknown'){
      unknownMode=usedMode;failure='Gemini 回覆結果未知。這次請求已鎖定。';detail='可先閱讀已完成的譯圖，並到設定查看請求紀錄。';return;
    }
    if(signal.aborted){detail='已取消處理，已儲存的文字與譯圖保留。';return;}
    const reason=(error instanceof Error?error.message:String(error)).replace(/^(?:Error: |GeminiFailure: )+/, '');
    const index=(error as {pageIndex?:number})?.pageIndex;
    failure=/Extension context invalidated/i.test(reason)?'墨譯已更新，請重新整理這個漫畫分頁。':gemini?'Gemini 校正未完成。'+reason:index===undefined?reason:'第 '+(index+1)+' 張未完成。'+reason;
    detail=gemini?'已完成的文字與譯圖可繼續使用。':'可到章節工作台處理該張，或從目前進度繼續。';
  }
  async function refineWork(images:HTMLImageElement[],signal:AbortSignal,usedMode:Mode){
    refining=true;detail=usedMode==='gemini-direct'?'已收齊日文原文，正在等待 Gemini 直譯。':'初譯可閱讀，正在等待 Gemini 校正。';
    try{await refineChapter(images,progress,signal,usedMode==='gemini-direct');refined=true;}
    catch(error){reportFailure(error,signal,usedMode,true);}
    finally{refining=false;refresh();}
  }
  async function run(){
    if(running||changingMode||direct&&(readiness!=='ready'||unknownMode===mode))return;
    const images=getImages(),usedMode=mode,wholeOcr=usedMode==='gemini-direct';
    if(!images.length){failure='尚未找到漫畫圖片，請捲動到漫畫頁面再試一次。';return;}
    const signal=begin();detail='準備翻譯本章…';
    try{
      await runChapter(images,progress,refresh,()=>stopped,signal,wholeOcr);
      signal.throwIfAborted();refresh();
      if(stopped){detail='已停止佇列。已完成的圖片與文字保留。';return;}
      if(wholeOcr){await refineWork(images,signal,usedMode);return;}
      detail='初譯已完成，可以閱讀或到工作台校正。';
      if(config.refineAfterChapter&&canRefineNow)await refineWork(images,signal,usedMode);
    }catch(error){reportFailure(error,signal,usedMode,false);}
    finally{finish();}
  }
  async function refine(){
    if(running||!canRefineNow)return;
    const signal=begin();
    try{await refineWork(getImages(),signal,'standard');}finally{finish();}
  }
</script>

<section class="moyu" aria-label="墨譯章節翻譯" class:collapsed>
  {#if collapsed}
    <button class="primary orb" bind:this={orb} data-comic-drag data-comic-anchor="collapsed" aria-label="展開墨譯浮球"
      title={failure||detail||'按一下展開墨譯'} onclick={event=>void collapse(false,event.currentTarget)}>
      <strong>墨</strong>{#if running}<small>{direct?counts.directReady:counts.readable}/{counts.total}</small>{:else if unknownMode===mode}<small>待確認</small>{/if}
    </button>
  {:else}
    <div class="handle" data-comic-drag>
      <strong>墨譯</strong>
      <button bind:this={collapseButton} data-comic-anchor="expanded" aria-label="縮成浮球" onclick={event=>void collapse(true,event.currentTarget)}>收合</button>
    </div>
    <div class="summary">
      <p role="status">
        {#if counts.total}<strong>已有 {counts.readable}／{counts.total} 張可以閱讀</strong>
          {#if counts.recognized||direct}<small>OCR 已完成 {direct?counts.directReady:counts.recognized}／{counts.total} 張</small>{/if}
          {#if counts.review}<small>{counts.review} 個文字框待核對</small>{/if}
        {:else}<strong>正在尋找漫畫圖片</strong>{/if}
      </p>
      {#if counts.total}
        <progress aria-label="整章可閱讀進度" value={counts.readable} max={counts.total}></progress>
      {/if}
    </div>
    <label class="mode">此分頁的整章模式
      <select aria-label="整章翻譯模式" disabled={!modeLoaded||running||changingMode} value={mode} onchange={event=>void changeMode(event.currentTarget.value as Mode)}>
        <option value="standard">逐張初譯</option><option value="gemini-direct">整章 OCR → Gemini 直譯</option>
      </select>
    </label>
    <div class="actions">
      {#if !running&&unknownMode===mode}
        <button class="primary" onclick={()=>openSettings('gemini-diagnostics')}>查看請求紀錄</button>
      {:else if !running&&direct&&!directComplete&&readiness!=='ready'}
        <button class="primary" disabled={readiness==='checking'} onclick={()=>openSettings('gemini')}>前往 Gemini 設定</button>
      {:else if !running&&canRefineNow&&!direct&&!refined}
        <button class="primary" onclick={refine}>整章 Gemini 校正</button>
      {:else if !running&&(direct?!directComplete:counts.standardReady<counts.total||!counts.total)}
        <button class="primary" disabled={!modeLoaded||!counts.total||changingMode} onclick={run}>{primaryRun}</button>
      {/if}
      <button class:primary={!running&&unknownMode!==mode&&(direct?directComplete:counts.total>0&&counts.standardReady===counts.total&&(!canRefineNow||refined))} disabled={running||!counts.total}
        onclick={e=>openChapter(e.currentTarget)}>章節工作台</button>
      {#if counts.readable}<button onclick={toggleOriginal}>原圖／譯圖</button>{/if}
      {#if running}
        {#if !refining}<button disabled={stopped} onclick={()=>{stopped=true;detail='已開始的圖片完成後停止。';}}>停止佇列</button>{/if}
        <button onclick={()=>{stopped=true;aborter?.abort();detail='正在取消，已存文字會保留。';}}>取消處理</button>
      {/if}
    </div>
    {#if detail}<p class="detail mx-note" role="status">{detail}</p>{/if}
    {#if !running&&(direct&&!directComplete||canRefine)&&readiness!=='ready'&&unknownMode!==mode}
      <p class="mx-warning">{readyMessage}{#if !direct} <button onclick={()=>openSettings('gemini')}>前往 Gemini 設定</button>{/if}</p>
    {/if}
    {#if failure}<p class="mx-alert" role="alert">{failure}</p>{/if}
    {#if running&&Object.keys(jobs).length}
      <ul aria-label="目前圖片任務">{#each Object.entries(jobs).sort((a,b)=>a[1].pageIndex-b[1].pageIndex) as [id,job] (id)}<li>第 {job.pageIndex+1} 張 · {job.message}</li>{/each}</ul>
    {/if}
    <details><summary>章節工具</summary>
      <div class="actions">
        <button onclick={()=>dispatchEvent(new CustomEvent('comic-pause-page'))}>暫停並釋放模型</button>
        {#if !direct&&refined&&canRefineNow}<button disabled={running} onclick={refine}>整章 Gemini 校正</button>{/if}
        {#if direct&&directComplete&&unknownMode!==mode}<button disabled={running||readiness!=='ready'} onclick={run}>再次執行整章直譯</button>{/if}
        <button onclick={()=>openSettings('gemini-diagnostics')}>查看 Gemini 請求紀錄</button>
      </div>
    </details>
  {/if}
</section>

<style>
  section { width: min(382px,calc(100vw - 24px)); max-height: min(540px,calc(100dvh - 24px)); overflow: auto; padding: 12px; border-radius: 14px; border: 1px solid var(--mx-border); background: var(--mx-paper); box-shadow: var(--mx-shadow); }
  section.collapsed { width: 64px; padding: 0; border-radius: 50%; }
  .handle { display: flex; align-items: center; justify-content: space-between; cursor: move; touch-action: none; }
  .handle strong { font-size: 17px; }
  .handle button { padding: 4px 8px; min-height: 29px; font-size: 12px; }
  .orb { display: grid; place-content: center; width: 62px; height: 62px; border-radius: 50%; touch-action: none; user-select: none; }
  .orb strong { font-size: 20px; }
  .orb small { line-height: 1.1; }
  .summary { background: var(--mx-tint); border: 1px solid var(--mx-line); border-radius: 9px; margin-top: 9px; padding: 8px 10px; font-variant-numeric: tabular-nums; }
  .summary p { margin: 0; }
  .summary small { display: block; color: var(--mx-muted); }
  .summary progress { appearance: none; display: block; width: 100%; height: 5px; border: 0; overflow: hidden; border-radius: 5px; margin-top: 7px; accent-color: var(--mx-green); background: #d6e4d6; }
  .summary progress::-webkit-progress-bar { background: #d6e4d6; }
  .summary progress::-webkit-progress-value { background: var(--mx-green); border-radius: 5px; }
  .mode { display: grid; gap: 3px; color: var(--mx-muted); font-size: 12px; margin: 8px 0; }
  .mode select { width: 100%; min-height: 34px; font-size: 13px; }
  p { margin: 7px 0 0; overflow-wrap: anywhere; }
  .actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  ul { max-height: 80px; overflow: auto; margin: 6px 0 0; padding-left: 20px; overflow-wrap: anywhere; }
  details { border-top: 1px solid var(--mx-line); padding-top: 7px; margin: 8px 0 0; }
  details .actions { margin-top: 6px; }
</style>
