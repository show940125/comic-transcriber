<script lang="ts">
  import {onMount} from 'svelte';
  import {detached} from './extension-context';
  import type { Diagnostic } from './types';
  import {settings} from './storage';
  let { getImages, runChapter, refineChapter, onRunning, openChapter, toggleOriginal }: {
    getImages:()=>HTMLImageElement[];
    runChapter:(images:HTMLImageElement[],progress:(d:Diagnostic)=>void,complete:()=>void,stopped:()=>boolean,signal:AbortSignal)=>Promise<void>;
    refineChapter?:(images:HTMLImageElement[],progress:(d:Diagnostic)=>void,signal:AbortSignal)=>Promise<void>;
    onRunning:(running:boolean)=>void;
    openChapter:()=>void;
    toggleOriginal:()=>void;
  }=$props();
  let running=$state(false), stopped=$state(false), total=$state(0), completed=$state(0), current=$state(0), detail=$state(''), failure=$state('');
  let aborter:AbortController|undefined;
  let collapsed=$state(false),releaseAfter=false,refining=$state(false);
  onMount(()=>{detached(async()=>{const value=await chrome.storage.local.get('dockCollapsed');collapsed=value.dockCollapsed===true;});const pause=()=>{stopped=true;releaseAfter=true;if(!running)detached(()=>chrome.runtime.sendMessage({channel:'runtime-release'}));};addEventListener('comic-pause',pause);return ()=>removeEventListener('comic-pause',pause);});
  function collapse(value:boolean,button?:HTMLElement){const rect=button?.getBoundingClientRect();collapsed=value;if(rect)button!.dispatchEvent(new CustomEvent('comic-dock-anchor',{bubbles:true,composed:true,detail:{mode:value?'collapsed':'expanded',x:rect.left+rect.width/2,y:rect.top+rect.height/2}}));detached(()=>chrome.storage.local.set({dockCollapsed:value}));}
  let jobs=$state<Record<string,{pageIndex:number;message:string}>>({});
  function progress(d:Diagnostic){
    current=(d.pageIndex??0)+1;detail=(stopped?'正在完成已開始圖片後停止 · ':'')+d.message;
    const key=d.jobId??String(d.pageIndex),next={...jobs};if(['complete','error','cancelled'].includes(d.stage))delete next[key];else next[key]={pageIndex:d.pageIndex??0,message:d.message};jobs=next;
  }
  async function run(){
    if(running)return;
    const images=getImages();total=images.length;completed=images.filter(i=>i.dataset.comicResult).length;
    if(!total){failure='尚未找到漫畫圖片，請先捲動至閱讀區再重試';return;}
    running=true;stopped=false;failure='';jobs={};onRunning(true);aborter=new AbortController();
    try{
      await runChapter(images,progress,()=>completed++,()=>stopped,aborter.signal);
      detail=stopped?'已停止；完成的圖片已保留':'本頁漫畫已處理完成';
      const config=await settings();
      if(!stopped&&config.backend==='google-web'&&config.refineAfterChapter&&refineChapter&&images.every(i=>i.dataset.comicResult)){
        refining=true;try{await refineChapter(images,progress,aborter.signal);}catch(error){if(aborter.signal.aborted)throw error;failure='Google 初譯已保留；二段校正：'+String(error);detail='初譯完成，校正未完成；可稍後按整章 Gemini 校正';}finally{refining=false;}
      }
    }catch(error){const reason=error instanceof Error?error.message:String(error),cancelled=aborter.signal.aborted,index=(error as {pageIndex?:number})?.pageIndex;failure=cancelled?'':/Extension context invalidated/i.test(reason)?'墨譯已更新，請重新整理漫畫頁後續翻；已完成對白可從快取恢復':`${stopped?'停止期間，':''}第 ${index===undefined?current:index+1} 張：${reason}`;detail=cancelled?'已取消；已存文字及完成圖片保留':stopped?'佇列已依操作停止；目前圖片的完成部分已保存':'已停下佇列，完成的圖片已保留；可校正或再按繼續';}
    finally{completed=getImages().filter(i=>i.dataset.comicResult).length;running=false;onRunning(false);if(releaseAfter){releaseAfter=false;detached(()=>chrome.runtime.sendMessage({channel:'runtime-release'}));}}
  }
  async function refine(){
    if(running||!refineChapter)return;running=true;refining=true;stopped=false;failure='';jobs={};onRunning(true);aborter=new AbortController();
    try{await refineChapter(getImages(),progress,aborter.signal);}catch(error){failure=aborter.signal.aborted?'':`已保留完成結果；二段校正：${String(error)}`;detail=aborter.signal.aborted?'校正已取消，完成結果與初譯保留':'校正未完成，原有譯文保留';}
    finally{running=false;refining=false;onRunning(false);if(releaseAfter){releaseAfter=false;detached(()=>chrome.runtime.sendMessage({channel:'runtime-release'}));}}
  }
</script>
<section aria-label="墨譯章節翻譯" class:collapsed>
  {#if !collapsed}<div class="handle" data-comic-drag><strong>墨譯</strong><button data-comic-anchor="expanded" aria-label="縮成浮球" onclick={event=>collapse(true,event.currentTarget)}>收合</button></div>{/if}
  {#if collapsed}<button class="orb" data-comic-drag data-comic-anchor="collapsed" aria-label="展開墨譯浮球" title={failure||detail||'拖曳移動；點擊展開'} onclick={event=>collapse(false,event.currentTarget)}>墨 {running?`${completed}/${total}`:failure?'!':''}</button>{:else}
  <div class="actions"><button disabled={running} onclick={run}>{completed&&completed<total?'繼續翻譯本頁':'翻譯本頁漫畫'}</button><button disabled={running} onclick={openChapter}>章節工作台</button><button onclick={toggleOriginal}>原圖／譯文</button>{#if refineChapter}<button disabled={running} onclick={refine}>整章 Gemini 校正</button>{/if}<button onclick={()=>dispatchEvent(new CustomEvent('comic-pause-page'))}>暫停並釋放</button>{#if running}{#if !refining}<button onclick={()=>{stopped=true;detail='完成已開始的最多兩張圖片後停止';}}>停止佇列</button>{/if}<button onclick={()=>{stopped=true;aborter?.abort();detail='取消處理，已存文字保留';}}>取消處理</button>{/if}</div>
  {#if total}<p role="status">已完成 {completed}/{total} 張{running?` · 第 ${current} 張`:''} · {detail}</p>{/if}
  {#if running&&Object.keys(jobs).length}<ul aria-label="目前圖片任務">{#each Object.entries(jobs).sort((a,b)=>a[1].pageIndex-b[1].pageIndex) as [id,job] (id)}<li>第 {job.pageIndex+1} 張 · {job.message}</li>{/each}</ul>{/if}
  {#if failure}<p role="alert">{failure}</p>{/if}
  {/if}
</section>
<style>section.collapsed{width:64px;padding:0;border-radius:50%}.handle{display:flex;align-items:center;justify-content:space-between;gap:10px;touch-action:none;cursor:move;padding-bottom:5px}.handle button{font-size:11px;padding:4px}.orb{border-radius:50%;width:62px;height:62px;min-width:62px;padding:3px;touch-action:none;user-select:none}section{background:#f3f3eb;color:#253d30;border:1px solid #8ba391;border-radius:10px;padding:10px 12px;box-shadow:0 3px 15px #0003;width:max-content;max-width:min(620px,calc(100vw - 24px));font:13px "Microsoft JhengHei",sans-serif;box-sizing:border-box}.actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}strong{font-size:17px}button{background:white;border:1px solid #afc1b1;color:#284e3c;border-radius:6px;padding:7px 10px;cursor:pointer;font:inherit}button:first-of-type{background:#284e3c;color:white}button:disabled{opacity:.5;cursor:default}p{margin:8px 0 0;line-height:1.5;max-width:480px;overflow-wrap:anywhere}ul{padding-left:18px;max-width:480px;max-height:90px;overflow:auto;overflow-wrap:anywhere}p[role=alert]{color:#8c3423}</style>
