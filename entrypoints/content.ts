import { defineContentScript } from 'wxt/utils/define-content-script';
import { settings,loadPage,cachePage,ocrReusePages } from '../src/storage';
import { imageBase64 } from '../src/binary';
import { mount, unmount } from 'svelte';
import ChapterDock from '../src/ChapterDock.svelte';
import {draggableDock} from '../src/dock-position';
import { chapterImages, imageSource,expectedImageAssignment } from '../src/site-images';
import type { Diagnostic,PageData,Settings } from '../src/types';
import type {ChapterEvent,ChapterPhase} from '../src/chapter-progress';
import {loadSession,processSession,encodeSession,sessionData,saveSession} from '../src/page-pipeline';
import {chapterSnapshot,chapterFingerprint,checkedRefinement,refinementContext,ChapterRefinementError} from '../src/chapter-refinement';
import {contentSignature} from '../src/core';
import {runPool,DeferredTranslationError,OrderedTurns} from '../src/scheduling';
import {extensionCall,detached,onContextInvalidated,invalidateContext,contextAlive,watchExtensionContext} from '../src/extension-context';
import {imageBytes} from '../src/binary';
import {saveSettings} from '../src/storage';
import theme from '../src/studio-theme.css?inline';
export default defineContentScript({
  matches: [],registration:'runtime',runAt: 'document_idle',
  main(ctx) {
    if(document.documentElement.hasAttribute('data-comic-active'))return;
    document.documentElement.setAttribute('data-comic-active','');
    const original = new WeakMap<HTMLImageElement, string>(), processed = new WeakMap<HTMLImageElement, string>();
    const chapterDrafts=new WeakMap<HTMLImageElement,PageData>();
    const directDrafts=new WeakMap<HTMLImageElement,PageData>();
    const recognizedPages=new WeakSet<HTMLImageElement>();
    const renderedPages=new WeakMap<HTMLImageElement,string>();
    const known = new WeakSet<HTMLImageElement>(), queue = new Set<HTMLImageElement>();
    let translating = false, dialog: HTMLDivElement | undefined, priorSummary = '', chapterKey = '';
    let closeDialog: ((restoreFocus?:boolean)=>void) | undefined;
    let editorOpening=0,editorOpener:HTMLElement|undefined;
    let batchRunning=false,softPaused=false,toolsHidden=false,dock:HTMLDivElement|undefined;
    let refreshDock:(()=>void)|undefined;
    const lifetime=new AbortController(),activeImages=new Map<HTMLImageElement,Promise<void>>(),activeSources=new Map<HTMLImageElement,string>(),eventDisposers:Array<()=>void>=[];
    let activeRun:Promise<void>|undefined,live=true;let disposeDock:(()=>void)|undefined,runAbort:AbortController|undefined,runUrl='';
    function applyImage(image:HTMLImageElement,data:Uint8Array<ArrayBuffer>,page?:PageData){
      original.set(image,original.get(image)??imageSource(image));image.dataset.comicOriginal=original.get(image);
      const url=URL.createObjectURL(new Blob([data],{type:'image/png'})),old=image.dataset.comicResult;
      if(old)URL.revokeObjectURL(old);image.dataset.comicResult=url;image.srcset='';image.src=url;image.loading='eager';image.removeAttribute('data-src');image.removeAttribute('data-original');processed.set(image,url);
      image.title='墨譯繁中頁面；按墨譯可校正，雙擊圖片切換原圖';
      if(page)renderedPages.set(image,chapterSnapshot([page]));
    }
    function pageBackend(page?:PageData){
      try{return page?JSON.parse(page.modelKey)[1]:undefined;}catch{return undefined;}
    }
    function chapterStatus(images:HTMLImageElement[],config:Settings){
      const key=contentSignature(config),readable=images.filter(i=>i.dataset.comicResult);
      return {
        total:images.length,
        readable:readable.length,
        recognized:images.filter(i=>recognizedPages.has(i)).length,
        directReady:images.filter(i=>directDrafts.has(i)).length,
        standardReady:readable.filter(i=>chapterDrafts.get(i)?.modelKey===key).length,
        googleReady:readable.filter(i=>chapterDrafts.get(i)?.modelKey===key&&pageBackend(chapterDrafts.get(i))==='google-web').length,
        directRendered:readable.filter(i=>chapterDrafts.get(i)?.refinement?.mode==='direct').length,
        review:images.reduce((total,i)=>total+Number(i.dataset.comicReview??'0'),0)
      };
    }
    async function runImages(images:HTMLImageElement[],report:(d:Diagnostic)=>void,complete:()=>void,stopped:()=>boolean,signal:AbortSignal,ocrOnly=false){
      if(batchRunning){softPaused=false;await extensionCall(()=>chrome.runtime.sendMessage({channel:'translation-resume'}));}
      if(activeRun)await activeRun.catch(()=>{});signal.throwIfAborted();lifetime.signal.throwIfAborted();
      const localAbort=new AbortController();runAbort=localAbort;runUrl=location.href;
      const conf=await settings(),chapterUrl=location.href,controller=AbortSignal.any([signal,lifetime.signal,localAbort.signal]);let failed=false;
      if(ocrOnly){const status=await extensionCall(()=>chrome.runtime.sendMessage({channel:'gemini-status'}));if(!status?.result?.ready){if(runAbort===localAbort)runAbort=undefined;throw new Error('請先在設定準備匿名 Gemini，再開始整章直譯');}}
      const reusableOcr=ocrOnly?await ocrReusePages(conf):undefined;
      const key=JSON.stringify([location.origin,location.pathname,conf.title,conf.chapter,conf.glossary]);if(key!==chapterKey){chapterKey=key;priorSummary=conf.priorSummary;}
      const limit=['google-web','chrome','gemini-web'].includes(conf.backend)?conf.pageConcurrency:1,turns=new OrderedTurns(),modelKey=contentSignature(conf);
      const operation=runPool(images,limit,async(image,index)=>{
        const displayed=chapterDrafts.get(image);
        if(image.dataset.comicResult&&!ocrOnly&&displayed?.modelKey===modelKey){
          for(const phase of ['prepare','ocr','translate','render'] as const)report({stage:'complete',pageIndex:index,message:'沿用已呈現的譯圖',chapterStep:{phase,status:'reused'}});
          turns.finish(index);return;
        }
        if(location.href!==chapterUrl||!image.isConnected)throw new Error('漫畫頁已變更，請重新啟動章節翻譯');
        const existing=activeImages.get(image);if(existing){await existing;return;}
        let phase:ChapterPhase='prepare',cachedOcr=false,cachedTranslation=false;
        const jobId=crypto.randomUUID(),started=performance.now();
        const progress=(d:Diagnostic)=>report({...d,jobId,pageIndex:index,chapterStep:d.chapterStep??{phase,status:'running'}});
        const mark=(status:ChapterEvent['status'],message:string)=>progress({stage:phase==='render'?'rendering':phase==='translate'?'translating':phase==='ocr'?'ocr':'loading',message,chapterStep:{phase,status}});
        const work=async()=>{
          let page:Awaited<ReturnType<typeof loadSession>>|undefined;
          const release=()=>{if(contextAlive())detached(()=>chrome.runtime.sendMessage({channel:'image-slot-release',id:jobId}));};
          const cancelWaiting=()=>{if(contextAlive())detached(()=>chrome.runtime.sendMessage({channel:'image-slot-cancel',id:jobId}));};
          controller.addEventListener('abort',cancelWaiting,{once:true});
          try{
            const slot=await extensionCall(()=>chrome.runtime.sendMessage({channel:'image-slot-acquire',id:jobId}));controller.throwIfAborted();if(!slot?.ok)throw new Error(slot?.error??'圖片排程未回應');
            delete image.dataset.comicError;progress({stage:'loading',message:'讀取圖片'});
            const source=original.get(image)??imageSource(image);let blob:Blob;
            if(/^https?:/.test(source)){const response=await extensionCall(()=>chrome.runtime.sendMessage({channel:'fetch-image',url:source}));if(!response?.ok)throw new Error(response?.error??'圖片讀取失敗');blob=new Blob([imageBytes(response.base64)],{type:response.mime});}
            else{const response=await bytes(image);blob=new Blob([imageBytes(response.base64)],{type:response.mime});}
            controller.throwIfAborted();page=await loadSession(blob,ocrOnly?{...conf,backend:'gemini-web'}:{...conf,priorSummary},controller);page.metadata={...page.metadata,sourcePageUrl:location.href,imageUrl:source,pageIndex:index};
            // Reuse verified OCR from the Google cache, keeping its translations
            // and manual corrections in their original, separate cache entry.
            if(ocrOnly&&!page.regions.length){const cached=reusableOcr?.get(page.hash);if(cached){page.regions=structuredClone(cached.regions).map(r=>({...r,translation:'',initialTranslation:undefined}));await saveSession(page);}}
            mark('done','圖片已載入');
            phase='ocr';cachedOcr=page.regions.length>0&&!page.regions.some(r=>!r.ocrDone&&!r.source.trim());
            mark('running','偵測與辨識日文文字框');
            try{await processSession(page,{ocrOnly,progress,signal:controller,beforeTranslate:async()=>{
              recognizedPages.add(image);refreshDock?.();
              mark(cachedOcr?'reused':'done',cachedOcr?'沿用已存原文':'日文 OCR 已完成');
              phase='translate';mark('running','準備逐頁翻譯');
              if(conf.backend==='gemini-web'){await turns.wait(index,controller);if(page!.config.priorSummary!==priorSummary){page!.config.priorSummary=priorSummary;page!.regions.forEach(r=>r.translation='');}}
              cachedTranslation=page!.regions.some(r=>!!r.translation.trim())&&!page!.regions.some(r=>r.source.trim()&&!r.needsReview&&!r.translation.trim());
            },canTranslate:()=>!failed,onFailure:()=>{failed=true;}});if(conf.backend==='gemini-web')priorSummary=page.regions.map(r=>r.translation).filter(Boolean).join('\n').slice(-1200);}finally{turns.finish(index);}
            controller.throwIfAborted();if(location.href!==chapterUrl||!image.isConnected||(original.get(image)??imageSource(image))!==source)throw new Error('漫畫頁或圖片已變更，已存文字保留');
            if(ocrOnly){directDrafts.set(image,sessionData(page));recognizedPages.add(image);image.dataset.comicOcr=page.hash;mark(cachedOcr?'reused':'done','日文 OCR 已保存，等待整章 Gemini 直譯');complete();return;}
            mark(cachedTranslation?'reused':'done',cachedTranslation?'沿用已存譯文':'本張翻譯階段完成');
            phase='render';
            progress({stage:'rendering',message:'嵌字及 PNG 編碼'});const renderStarted=performance.now(),data=await encodeSession(page);progress({stage:'rendering',message:'嵌字及 PNG 完成',ms:performance.now()-renderStarted});controller.throwIfAborted();if(!live)return;
            chapterDrafts.set(image,sessionData(page));applyImage(image,data,chapterDrafts.get(image));image.dataset.comicReview=String(page.regions.filter(r=>r.needsReview||r.warnings.some(w=>/^原文清除需校正|^中文空間不足/.test(w))).length);
            if(limit===1)priorSummary=page.regions.map(r=>r.translation).filter(Boolean).join('\n').slice(-1200);
            progress({stage:'complete',message:'本張完成並已呈現',ms:performance.now()-started,chapterStep:{phase,status:'done'}});complete();
          }catch(error){
            if(!(error instanceof DeferredTranslationError))failed=true;
            image.dataset.comicError=error instanceof Error?error.message:String(error);if(/403|429/.test(image.dataset.comicError))softPaused=true;
            if(error instanceof Error&&Object.isExtensible(error))Object.assign(error,{pageIndex:index,jobId});
            progress({stage:controller.aborted?'cancelled':'error',message:image.dataset.comicError});
            if(/out of memory|allocation failed|memory access out of bounds|gpu.*lost/i.test(image.dataset.comicError)){
              const current=await settings();await saveSettings({...current,pageConcurrency:1});image.dataset.comicError+='；已改為一張模式，續翻可恢復';
            }
            throw error;
          }finally{turns.finish(index);page?.dispose();controller.removeEventListener('abort',cancelWaiting);release();}
        };
        activeSources.set(image,original.get(image)??imageSource(image));
        const task=work();activeImages.set(image,task);try{await task;}finally{activeImages.delete(image);activeSources.delete(image);}
      },{stopped:()=>stopped()||softPaused,signal:controller,failed:()=>failed});
      activeRun=operation;try{await operation;}finally{if(activeRun===operation)activeRun=undefined;if(runAbort===localAbort)runAbort=undefined;}
    }
    async function bytes(image: HTMLImageElement) {
      const url = original.get(image) ?? image.currentSrc;
      try { const res = await fetch(url,{signal:AbortSignal.timeout(10000)}); if (!res.ok) throw new Error('圖片讀取失敗'); const blob = await res.blob(); if (!blob.type.startsWith('image/') || blob.size > 20 * 1024 * 1024) throw new Error('圖片格式或大小不支援'); return { base64: imageBase64(new Uint8Array(await blob.arrayBuffer())), mime: blob.type }; }
      catch (error) {
        if (url.startsWith('blob:') || url.startsWith('data:')) throw error;
        const response = await extensionCall(()=>chrome.runtime.sendMessage({ channel: 'fetch-image', url })); if (!response.ok) throw new Error(response.error); return response;
      }
    }
    async function refineImages(images:HTMLImageElement[],report:(d:Diagnostic)=>void,signal:AbortSignal,direct=false,standalone=false){
      const storedConf=await settings(),conf=direct?{...storedConf,backend:'gemini-web' as const}:storedConf;if(!direct&&conf.backend!=='google-web')throw new Error('整章二段校正使用 Google 初譯，請將翻譯來源設為 Google');
      const drafts=direct?directDrafts:chapterDrafts;
      if(!images.length||images.some(i=>(!direct&&!i.dataset.comicResult)||!drafts.has(i)))throw new Error(direct?'請先完成本頁全部圖片的 OCR':'請先完成本頁全部圖片的初譯；已完成文字可從快取續翻');
      const sources=images.map(i=>original.get(i)??imageSource(i)),chapterUrl=location.href;
      const localAbort=new AbortController();runAbort=localAbort;runUrl=chapterUrl;
      const controller=AbortSignal.any([signal,lifetime.signal,localAbort.signal]),id=crypto.randomUUID();
      const currentPages=()=>images.map(i=>drafts.get(i)!);
      const refreshDrafts=async()=>{for(const image of images){const saved=drafts.get(image)!;const cached=await loadPage(saved.hash,saved.modelKey);if(cached)drafts.set(image,cached);}};
      const assertChapter=()=>{controller.throwIfAborted();const current=chapterImages();if(location.href!==chapterUrl||current.length!==images.length||current.some((i,n)=>i!==images[n]||!i.isConnected||(original.get(i)??imageSource(i))!==sources[n]))throw new Error('漫畫頁或圖片已變更，二段校正不套用');};
      await refreshDrafts();assertChapter();
      const input=structuredClone(currentPages()),snapshot=chapterSnapshot(input),fingerprint=await chapterFingerprint(input),contextKey=await refinementContext(conf,direct);
      const reused=input.every(p=>p.refinement?.outputFingerprint===fingerprint&&p.refinement.contextKey===contextKey);
      if(standalone)report({stage:'loading',message:'已核對本章保存的初譯',chapterStep:{phase:'prepare',status:'reused'}});
      if(reused&&images.every((i,n)=>i.dataset.comicResult&&renderedPages.get(i)===chapterSnapshot([input[n]]))){
        for(let index=0;index<images.length;index++)report({stage:'complete',message:'沿用已套用的譯圖',pageIndex:index,chapterStep:{phase:'reflow',status:'reused'}});
        report({stage:'complete',message:'整章翻譯／校正已完成，沿用已存結果',chapterStep:{phase:'gemini',status:'reused'}});
        if(runAbort===localAbort)runAbort=undefined;return;
      }
      const readiness=await extensionCall(()=>chrome.runtime.sendMessage({channel:'gemini-status'}));
      if(!readiness?.ok||!readiness.result?.ready){if(runAbort===localAbort)runAbort=undefined;throw new Error(readiness?.error??'Google 初譯已完成；請先在設定準備匿名 Gemini，才能進行整章校正');}
      const listener=(m:any)=>{if(m.channel==='progress'&&m.id===id)report({...m.diagnostic,chapterStep:{phase:'gemini',status:'running'}});};
      const cancel=()=>{if(contextAlive()){detached(()=>chrome.runtime.sendMessage({channel:'cancel',id}));detached(()=>chrome.runtime.sendMessage({channel:'image-slot-cancel',id}));}};
      controller.addEventListener('abort',cancel,{once:true});
      try{
        assertChapter();const slot=await extensionCall(()=>chrome.runtime.sendMessage({channel:'image-slot-acquire',id}));if(!slot?.ok)throw new Error(slot?.error??'校正排程未回應');
        await extensionCall(()=>chrome.runtime.onMessage.addListener(listener));assertChapter();
        if(!reused)report({stage:'translating',message:`${direct?'OCR 完成':'Google 初譯完成'}，Gemini 正在閱讀整章 ${images.length} 張`,backend:'gemini-web/refinement',chapterStep:{phase:'gemini',status:'running'}});
        const response=reused?{ok:true,result:{pages:input,fingerprint,regions:input.flatMap(p=>p.regions).filter(r=>r.translation).length,changed:0,ms:0}}:await extensionCall(()=>chrome.runtime.sendMessage({channel:direct?'gemini-chapter':'gemini-refine',id,pages:input,settings:conf}));
        if(!response?.ok){
          const message=response?.error??'整章 Gemini 請求未回應';
          throw new ChapterRefinementError(message,response?.state==='unknown'||message.includes('結果未知')?'unknown':'failed');
        }
        assertChapter();
        if(response.result.fingerprint!==fingerprint)throw new Error('整章校正輸入指紋不一致');
        const latest=await settings();if(latest.backend!==storedConf.backend||await refinementContext(latest,direct)!==contextKey)throw new Error('翻譯設定、上下文或專屬指示已變更，舊校正結果不套用');
        await refreshDrafts();assertChapter();
        const output=checkedRefinement(currentPages(),snapshot,response.result);
        // Persist all validated translations before PNG work. A later rendering
        // cancellation can resume from this result without another Gemini call.
        for(let index=0;index<output.length;index++){await cachePage(output[index]);drafts.set(images[index],output[index]);}
        report({stage:'rendering',message:reused?'沿用已核對的 Gemini 回覆':'Gemini 回覆已核對並保存',chapterStep:{phase:'gemini',status:reused?'reused':'done'}});
        // Validate the entire response before changing any displayed page.
        for(let index=0;index<images.length;index++){
          assertChapter();const image=images[index],p=output[index];report({stage:'rendering',message:`整章校正核對完成，重排 ${index+1}/${images.length}`,pageIndex:index,chapterStep:{phase:'reflow',status:'running'}});
          const data=await bytes(image),page=await loadSession(new Blob([imageBytes(data.base64)],{type:data.mime}),conf,controller);
          try{if(page.hash!==p.hash)throw new Error('圖片內容已變更，停止套用校正');page.regions=p.regions;page.metadata={sourcePageUrl:chapterUrl,imageUrl:sources[index],pageIndex:index,refinement:p.refinement};const png=await encodeSession(page);assertChapter();chapterDrafts.set(image,sessionData(page));applyImage(image,png,chapterDrafts.get(image));image.dataset.comicReview=String(page.regions.filter(r=>r.needsReview||r.warnings.some(w=>/^原文清除需校正|^中文空間不足/.test(w))).length);}
          finally{page.dispose();}
          report({stage:'complete',message:'校正版譯圖已套用',pageIndex:index,chapterStep:{phase:'reflow',status:'done'}});
        }
        report({stage:'complete',message:direct?`整章 Gemini 直譯完成：${images.length} 張、${response.result.regions} 個區域`:`整章二段校正完成：${response.result.regions} 個區域，修改 ${response.result.changed} 處`,backend:'gemini-web/refinement',ms:response.result.ms});
      }finally{controller.removeEventListener('abort',cancel);if(contextAlive()){detached(()=>chrome.runtime.onMessage.removeListener(listener));detached(()=>chrome.runtime.sendMessage({channel:'image-slot-release',id}));}if(runAbort===localAbort)runAbort=undefined;}
    }
    function focusedElement(){
      let focused=document.activeElement;
      while(focused?.shadowRoot?.activeElement)focused=focused.shadowRoot.activeElement;
      return focused instanceof HTMLElement?focused:undefined;
    }
    async function open(image: HTMLImageElement, auto = false, report?:(diagnostic:Diagnostic)=>void,opener=editorOpener??focusedElement()) {
      const opening=++editorOpening;
      const editorUrl=location.href;
      const {default:Reader}=await import('../src/Reader.svelte');
      if(!auto&&batchRunning)return;
      await activeImages.get(image)?.catch(()=>{});
      delete image.dataset.comicError;
      const source = original.get(image) ?? imageSource(image);
      const input: {imageUrl?:string;base64?:string;mime?:string} = /^https?:/.test(source) ? {imageUrl:source} : await bytes(image);
      const conf = await settings(), key = JSON.stringify([location.origin, location.pathname, conf.title, conf.chapter, conf.glossary]);
      if (key !== chapterKey) { priorSummary = conf.priorSummary; chapterKey = key; }
      if(!live||opening!==editorOpening||editorUrl!==location.href||!image.isConnected||!auto&&batchRunning)return;
      if(!auto){closeDialog?.(false);editorOpener=opener;}
      const holder=document.createElement('div');holder.setAttribute('data-comic-studio','');
      let targetSrc=image.src,targetSrcset=image.srcset;
      const shadow=holder.attachShadow({mode:'open'}), container=document.createElement('div'),style=document.createElement('style');
      style.textContent=theme+`
        .chapter-editor { padding:0; overflow:hidden; width:min(1540px,calc(100% - 28px)); height:calc(100dvh - 28px); max-width:none; max-height:none; margin:auto; }
        .chapter-editor > div { height:100%; }
        @media (max-width:660px) { .chapter-editor { width:calc(100% - 10px); height:calc(100dvh - 10px); border-radius:8px; } }
      `;
      const shell=document.createElement('div');shell.className='moyu';
      const modal=auto?undefined:document.createElement('dialog');
      const pages=chapterImages(),index=Math.max(0,pages.indexOf(image));
      if(!auto){
        modal!.className='chapter-editor';modal!.setAttribute('aria-labelledby','comic-editor-title');
        modal!.append(container);shell.append(modal!);
      }else{holder.hidden=true;shell.append(container);}
      shadow.append(style,shell);shadow.addEventListener('click',event=>event.stopPropagation());shadow.addEventListener('keydown',event=>event.stopPropagation());
      (document.body??document.documentElement).append(holder);if(!auto)dialog=holder;
      return new Promise<void>(resolve => {
        let closed=false;
        const close=(restoreFocus=true)=>{
          if(closed)return;
          closed=true;component.retireImport();modal?.close();void unmount(component).catch(()=>{});holder.remove();
          if(dialog===holder){dialog=undefined;closeDialog=undefined;if(restoreFocus){editorOpening++;editorOpener=undefined;opener?.focus({preventScroll:true});}}
          resolve();
        };
        const chapterNav=modal?{
          index,pages:pages.map(page=>({src:original.get(page)??imageSource(page),ready:!!page.dataset.comicResult,failed:!!page.dataset.comicError})),
          select:(next:number)=>{if(next!==index&&pages[next])detached(()=>open(pages[next],false,undefined,opener),error=>component.showError(error));}
        }:undefined;
        const component=mount(Reader,{target:container,props:{chapterNav,onClose:()=>close(),siteTargetCurrent:()=>!closed&&live&&holder.isConnected&&image.isConnected&&image.src===targetSrc&&image.srcset===targetSrcset&&location.href===editorUrl&&(original.get(image)??imageSource(image))===source,siteInput:{...input,auto,priorSummary,pageData:chapterDrafts.get(image),sourcePageUrl:location.href,pageIndex:index},onSiteProgress:report,onSiteReview:count=>{image.dataset.comicReview=String(count);},onSiteSummary:summary=>{if(auto)priorSummary=summary;},onSiteApply:(data,page)=>{
            if(closed||!live||!image.isConnected||(original.get(image)??imageSource(image))!==source)throw new Error('工作台目標圖片已變更，請重新開啟');
            if(page){
              chapterDrafts.set(image,page);
              if(pageBackend(page)==='gemini-web'&&directDrafts.has(image))directDrafts.set(image,page);
              if(page.regions.every(r=>r.ocrDone||r.source.trim()))recognizedPages.add(image);
            }
            applyImage(image,data,page);targetSrc=image.src;targetSrcset=image.srcset;refreshDock?.();
            if(auto)close();
          },onSiteError:error=>{image.dataset.comicError=error;if(auto)close();}}});
        if(modal){
          modal.addEventListener('cancel',event=>{event.preventDefault();close();});
          closeDialog=close;modal.showModal();container.querySelector<HTMLElement>('h1')?.focus({preventScroll:true});
        }
      });
    }
    async function drain() {
      if (!live||softPaused||translating||batchRunning||dialog) return; translating = true;
      try {
        while (queue.size&&!softPaused&&!dialog) {
          const images = [...queue].sort((a, b) => Math.abs(a.getBoundingClientRect().top) - Math.abs(b.getBoundingClientRect().top));
          const image = images[0]; queue.delete(image);
          if (!image.isConnected || image.dataset.comicResult || !image.complete) continue;
          const conf = await settings(); if (!conf.auto) break;
          const batch=[image,...images.slice(1).filter(i=>i.isConnected&&!i.dataset.comicResult&&i.complete)];for(const next of batch)queue.delete(next);
          try { await runImages(batch,()=>{},()=>{},()=>batchRunning,lifetime.signal); } catch (e) { image.dataset.comicError = String(e); }
        }
      } finally { translating = false; }
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) queue.add(entry.target as HTMLImageElement);
      detached(async()=>{const conf=await settings();if(conf.auto)await drain();else queue.clear();});
    }, { rootMargin: '800px' });
    function scan() {
      if(!live)return;
      const pages=chapterImages();
      if(pages.length&&!dock){
        dock=document.createElement('div');dock.setAttribute('data-comic-dock','');dock.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483646;';
        const shadow=dock.attachShadow({mode:'open'});shadow.addEventListener('click',event=>event.stopPropagation());
        const container=document.createElement('div'),style=document.createElement('style');style.textContent=theme;shadow.append(style,container);(document.body??document.documentElement).append(dock);
        const component=mount(ChapterDock,{target:container,props:{
          getImages:chapterImages,getActivity:chapterStatus,onRunning:running=>batchRunning=running,runChapter:runImages,refineChapter:refineImages,
          openChapter:opener=>{
            const images=chapterImages(),viewportCenter=innerHeight/2;
            const distance=(image:HTMLImageElement)=>{const r=image.getBoundingClientRect();return Math.abs((r.top+r.bottom)/2-viewportCenter);};
            const next=images.find(i=>i.dataset.comicError)||images.reduce<HTMLImageElement|undefined>((near,image)=>!near||distance(image)<distance(near)?image:near,undefined);
            if(next)detached(()=>open(next,false,undefined,opener),error=>component.showError(error));
          },
          toggleOriginal:()=>{
            const images=chapterImages().filter(i=>i.dataset.comicResult),showRaw=images.some(i=>i.src===i.dataset.comicResult);
            for(const image of images){const raw=original.get(image)||image.dataset.comicOriginal;if(raw&&image.dataset.comicResult){image.srcset='';image.src=showRaw?raw:image.dataset.comicResult;}}
          }
        }});
        refreshDock=component.refresh;
        const stopDrag=draggableDock(dock,p=>detached(()=>chrome.storage.local.set({dockPosition:p})));eventDisposers.push(stopDrag);
        detached(async()=>{const {dockPosition}=await chrome.storage.local.get<{dockPosition?:{x:number;y:number}}>('dockPosition');if(dockPosition&&dock){dock.style.left=Math.max(4,Math.min(dockPosition.x,innerWidth-dock.offsetWidth-4))+'px';dock.style.top=Math.max(4,Math.min(dockPosition.y,innerHeight-dock.offsetHeight-4))+'px';dock.style.right=dock.style.bottom='auto';}const state=await chrome.runtime.sendMessage({channel:'tab-tools-state'});toolsHidden=state?.hidden===true;if(toolsHidden&&dock)dock.style.display='none';});
        disposeDock=()=>{refreshDock=undefined;void unmount(component).catch(()=>{});dock?.remove();};ctx.onInvalidated(disposeDock);
      }
      refreshDock?.();
      for (const image of pages) {
        if (known.has(image) || image.naturalWidth < 300 || image.naturalHeight < 300) continue;
        known.add(image); observer.observe(image);
        const trigger = document.createElement('button');trigger.setAttribute('data-comic-trigger',''); trigger.type = 'button'; trigger.textContent = '墨譯'; trigger.title = '翻譯／校正這張漫畫';
        trigger.style.cssText = 'position:fixed;display:none;z-index:2147483646;background:#284e3c;color:white;border:0;border-radius:14px;padding:7px 13px;font:13px sans-serif;cursor:pointer';
        const show = () => {if(toolsHidden)return;const rect = image.getBoundingClientRect(); trigger.style.left = Math.max(4, Math.min(innerWidth - 65, rect.right - 60)) + 'px'; trigger.style.top = Math.max(4, rect.top + 8) + 'px'; trigger.style.display = 'block'; };
        let timer:ReturnType<typeof setTimeout>|undefined;
        const hide=()=>{if(!trigger.matches(':hover,:focus')&&editorOpener!==trigger)trigger.style.display='none';};
        const leave=()=>{timer=setTimeout(hide,180);};
        image.addEventListener('mouseenter',show);image.addEventListener('mouseleave',leave);eventDisposers.push(()=>{image.removeEventListener('mouseenter',show);image.removeEventListener('mouseleave',leave);if(timer)clearTimeout(timer);});
        trigger.onmouseleave=hide;trigger.onblur=hide;
        trigger.onclick = event => { event.preventDefault(); event.stopImmediatePropagation(); trigger.textContent = '墨譯'; detached(()=>open(image,false,undefined,trigger),e=>{image.dataset.comicError=String(e);trigger.textContent='讀取失敗';trigger.title=String(e);}); };
        const toggle=()=>{const raw=original.get(image),result=image.dataset.comicResult;if(raw&&result){image.src=image.src===result?raw:result;processed.set(image,image.currentSrc);}};image.addEventListener('dblclick',toggle);eventDisposers.push(()=>image.removeEventListener('dblclick',toggle));
        (document.body??document.documentElement).append(trigger); ctx.onInvalidated(() => trigger.remove());
      }
    }
    const mutations = new MutationObserver(records => {
      if(!live)return;
      if(runAbort&&location.href!==runUrl)runAbort.abort(new DOMException('漫畫章節已變更','AbortError'));
      for (const record of records) if (record.type === 'attributes' && record.target instanceof HTMLImageElement) {
        const image = record.target;
        if(expectedImageAssignment(image,record.attributeName,activeSources.get(image)))continue;
        if (image.dataset.comicResult === image.src || image.src === (original.get(image)??image.dataset.comicOriginal)) continue;
        if (image.currentSrc !== processed.get(image)) {
          if(activeImages.has(image))runAbort?.abort(new DOMException('漫畫圖片已變更','AbortError'));
          original.delete(image);processed.delete(image);chapterDrafts.delete(image);directDrafts.delete(image);recognizedPages.delete(image);
          if(image.dataset.comicResult)URL.revokeObjectURL(image.dataset.comicResult);
          delete image.dataset.comicOriginal;delete image.dataset.comicResult;delete image.dataset.comicReview;delete image.dataset.comicOcr;
          if(image.complete){queue.add(image);detached(async()=>{const conf=await settings();if(conf.auto)await drain();});}
        }
      }
      scan();
    });
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    document.addEventListener('load', scan, true); scan();
    const navigation=()=>runAbort?.abort(new DOMException('漫畫頁已變更','AbortError'));addEventListener('popstate',navigation);eventDisposers.push(()=>removeEventListener('popstate',navigation));
    const pausePage=()=>{softPaused=true;queue.clear();dispatchEvent(new CustomEvent('comic-pause'));detached(()=>chrome.runtime.sendMessage({channel:'runtime-release'}));};
    addEventListener('comic-pause-page',pausePage);eventDisposers.push(()=>removeEventListener('comic-pause-page',pausePage));
    const receive=(message:any,_sender:any,reply:(value:any)=>void)=>{if(!live)return;
      if(message.channel==='page-tools-state'){reply({ok:true,hidden:toolsHidden,hasImages:chapterImages().length>0});}
      if(message.channel==='tools-visibility'){toolsHidden=message.hidden===true;if(dock)dock.style.display=toolsHidden?'none':'';if(toolsHidden){closeDialog?.();for(const trigger of document.querySelectorAll<HTMLElement>('[data-comic-trigger]'))trigger.style.display='none';}reply({ok:true});}
      if(message.channel==='pause-tools'){pausePage();reply({ok:true});}
      if(message.channel==='open-image'){const image=[...document.images].find(i=>i.currentSrc===message.url||original.get(i)===message.url);if(image)detached(()=>open(image));}
    };
    detached(()=>chrome.runtime.onMessage.addListener(receive));
    const cleanup=()=>{
      if(!live)return;live=false;lifetime.abort();observer.disconnect();mutations.disconnect();queue.clear();document.removeEventListener('load',scan,true);
      document.documentElement.removeAttribute('data-comic-active');
      for(const dispose of eventDisposers)dispose();closeDialog?.();disposeDock?.();dock?.remove();
      for(const trigger of document.querySelectorAll('[data-comic-trigger]'))trigger.remove();
      if(contextAlive())detached(()=>chrome.runtime.onMessage.removeListener(receive));
      const notice=document.createElement('div');notice.setAttribute('role','status');notice.setAttribute('data-comic-updated','');notice.textContent='墨譯已更新，請重新整理漫畫頁後續翻；完成圖片已保留';notice.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483646;background:#f3f3eb;color:#253d30;border:1px solid #8ba391;border-radius:8px;padding:12px;font:13px sans-serif';(document.body??document.documentElement).append(notice);
    };
    onContextInvalidated(cleanup);ctx.onInvalidated(()=>{cleanup();invalidateContext();});
    eventDisposers.push(watchExtensionContext());
  },
});
