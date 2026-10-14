<script lang="ts">
  import type { Diagnostic } from './types';
  let { getImages, runChapter, onRunning, openChapter, toggleOriginal }: {
    getImages:()=>HTMLImageElement[];
    runChapter:(images:HTMLImageElement[],progress:(d:Diagnostic)=>void,complete:()=>void,stopped:()=>boolean,signal:AbortSignal)=>Promise<void>;
    onRunning:(running:boolean)=>void;
    openChapter:()=>void;
    toggleOriginal:()=>void;
  }=$props();
  let running=$state(false), stopped=$state(false), total=$state(0), completed=$state(0), current=$state(0), detail=$state(''), failure=$state('');
  let aborter:AbortController|undefined;
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
    }catch(error){const reason=error instanceof Error?error.message:String(error),cancelled=aborter.signal.aborted,index=(error as {pageIndex?:number})?.pageIndex;failure=cancelled?'':/Extension context invalidated/i.test(reason)?'墨譯已更新，請重新整理漫畫頁後續翻；已完成對白可從快取恢復':`${stopped?'停止期間，':''}第 ${index===undefined?current:index+1} 張：${reason}`;detail=cancelled?'已取消；已存文字及完成圖片保留':stopped?'佇列已依操作停止；目前圖片的完成部分已保存':'已停下佇列，完成的圖片已保留；可校正或再按繼續';}
    finally{completed=getImages().filter(i=>i.dataset.comicResult).length;running=false;onRunning(false);}
  }
</script>
<section aria-label="墨譯章節翻譯">
  <div class="actions"><strong>墨譯</strong><button disabled={running} onclick={run}>{completed&&completed<total?'繼續翻譯本頁':'翻譯本頁漫畫'}</button><button disabled={running} onclick={openChapter}>章節工作台</button><button onclick={toggleOriginal}>原圖／譯文</button>{#if running}<button onclick={()=>{stopped=true;detail='完成已開始的最多兩張圖片後停止';}}>停止佇列</button><button onclick={()=>{stopped=true;aborter?.abort();detail='取消處理，已存文字保留';}}>取消處理</button>{/if}</div>
  {#if total}<p role="status">已完成 {completed}/{total} 張{running?` · 第 ${current} 張`:''} · {detail}</p>{/if}
  {#if running&&Object.keys(jobs).length}<ul aria-label="目前圖片任務">{#each Object.entries(jobs).sort((a,b)=>a[1].pageIndex-b[1].pageIndex) as [id,job] (id)}<li>第 {job.pageIndex+1} 張 · {job.message}</li>{/each}</ul>{/if}
  {#if failure}<p role="alert">{failure}</p>{/if}
</section>
<style>section{background:#f3f3eb;color:#253d30;border:1px solid #8ba391;border-radius:10px;padding:10px 12px;box-shadow:0 3px 15px #0003;max-width:min(650px,95vw);font:13px "Microsoft JhengHei",sans-serif}.actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}strong{font-size:17px}button{background:white;border:1px solid #afc1b1;color:#284e3c;border-radius:6px;padding:7px 10px;cursor:pointer;font:inherit}button:first-of-type{background:#284e3c;color:white}button:disabled{opacity:.5;cursor:default}p{margin:8px 0 0;line-height:1.5}p[role=alert]{color:#8c3423}</style>
