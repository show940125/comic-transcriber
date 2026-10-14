<script lang="ts">
  import type { Diagnostic } from './types';
  let { getImages, translateImage, onRunning, openChapter, toggleOriginal }: {
    getImages:()=>HTMLImageElement[];
    translateImage:(image:HTMLImageElement,progress:(d:Diagnostic)=>void)=>Promise<void>;
    onRunning:(running:boolean)=>void;
    openChapter:()=>void;
    toggleOriginal:()=>void;
  }=$props();
  let running=$state(false), stopped=$state(false), total=$state(0), completed=$state(0), current=$state(0), detail=$state(''), failure=$state('');
  async function run(){
    if(running)return;
    const images=getImages();total=images.length;completed=images.filter(i=>i.dataset.comicResult).length;
    if(!total){failure='尚未找到漫畫圖片，請先捲動至閱讀區再重試';return;}
    running=true;stopped=false;failure='';onRunning(true);const chapterUrl=location.href;
    try{
      for(const [index,image]of images.entries()){
        if(stopped)break;
        if(location.href!==chapterUrl||!image.isConnected)throw new Error('漫畫頁已變更，請重新啟動章節翻譯');
        if(image.dataset.comicResult)continue;
        current=index+1;detail='讀取圖片';
        await translateImage(image,d=>detail=(stopped?'正在完成目前圖片後停止 · ':'')+d.message);
        completed++;
      }
      detail=stopped?'已停止；完成的圖片已保留':'本頁漫畫已處理完成';
    }catch(error){const reason=error instanceof Error?error.message:String(error);failure=/Extension context invalidated/i.test(reason)?'墨譯已更新，請重新整理漫畫頁後續翻；已完成對白可從快取恢復':`${stopped?'停止期間，':''}第 ${current} 張：${reason}`;detail=stopped?'佇列已依操作停止；目前圖片的完成部分已保存':'已停下佇列，完成的圖片已保留；可校正或再按繼續';}
    finally{running=false;onRunning(false);}
  }
</script>
<section aria-label="墨譯章節翻譯">
  <div class="actions"><strong>墨譯</strong><button disabled={running} onclick={run}>{completed&&completed<total?'繼續翻譯本頁':'翻譯本頁漫畫'}</button><button disabled={running} onclick={openChapter}>章節工作台</button><button onclick={toggleOriginal}>原圖／譯文</button>{#if running}<button onclick={()=>{stopped=true;detail='完成目前圖片後停止';}}>停止佇列</button>{/if}</div>
  {#if total}<p role="status">已完成 {completed}/{total} 張{running?` · 第 ${current} 張`:''} · {detail}</p>{/if}
  {#if failure}<p role="alert">{failure}</p>{/if}
</section>
<style>section{background:#f3f3eb;color:#253d30;border:1px solid #8ba391;border-radius:10px;padding:10px 12px;box-shadow:0 3px 15px #0003;max-width:min(650px,95vw);font:13px "Microsoft JhengHei",sans-serif}.actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}strong{font-size:17px}button{background:white;border:1px solid #afc1b1;color:#284e3c;border-radius:6px;padding:7px 10px;cursor:pointer;font:inherit}button:first-of-type{background:#284e3c;color:white}button:disabled{opacity:.5;cursor:default}p{margin:8px 0 0;line-height:1.5}p[role=alert]{color:#8c3423}</style>
