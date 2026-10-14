import { defineContentScript } from 'wxt/utils/define-content-script';
import { settings } from '../src/storage';
import { imageBase64 } from '../src/binary';
import { mount, unmount } from 'svelte';
import Reader from '../src/Reader.svelte';
import ChapterDock from '../src/ChapterDock.svelte';
import { chapterImages, imageSource,expectedImageAssignment } from '../src/site-images';
import type { Diagnostic } from '../src/types';
import {loadSession,processSession,encodeSession} from '../src/page-pipeline';
import {runPool,DeferredTranslationError} from '../src/scheduling';
import {extensionCall,detached,onContextInvalidated,invalidateContext,contextAlive,watchExtensionContext} from '../src/extension-context';
import {imageBytes} from '../src/binary';
import {saveSettings} from '../src/storage';
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'], runAt: 'document_idle',
  main(ctx) {
    const original = new WeakMap<HTMLImageElement, string>(), processed = new WeakMap<HTMLImageElement, string>();
    const known = new WeakSet<HTMLImageElement>(), queue = new Set<HTMLImageElement>();
    let translating = false, dialog: HTMLDivElement | undefined, priorSummary = '', chapterKey = '';
    let closeDialog: (()=>void) | undefined;
    let batchRunning=false, dock:HTMLDivElement|undefined;
    const lifetime=new AbortController(),activeImages=new Map<HTMLImageElement,Promise<void>>(),activeSources=new Map<HTMLImageElement,string>(),eventDisposers:Array<()=>void>=[];
    let activeRun:Promise<void>|undefined,live=true;let disposeDock:(()=>void)|undefined,runAbort:AbortController|undefined,runUrl='';
    function applyImage(image:HTMLImageElement,data:Uint8Array<ArrayBuffer>){
      original.set(image,original.get(image)??imageSource(image));image.dataset.comicOriginal=original.get(image);
      const url=URL.createObjectURL(new Blob([data],{type:'image/png'})),old=image.dataset.comicResult;
      if(old)URL.revokeObjectURL(old);image.dataset.comicResult=url;image.srcset='';image.src=url;image.loading='eager';image.removeAttribute('data-src');image.removeAttribute('data-original');processed.set(image,url);
      image.title='墨譯繁中頁面；按墨譯可校正，雙擊圖片切換原圖';
    }
    async function runImages(images:HTMLImageElement[],report:(d:Diagnostic)=>void,complete:()=>void,stopped:()=>boolean,signal:AbortSignal){
      if(activeRun)await activeRun.catch(()=>{});signal.throwIfAborted();lifetime.signal.throwIfAborted();
      const localAbort=new AbortController();runAbort=localAbort;runUrl=location.href;
      const conf=await settings(),chapterUrl=location.href,controller=AbortSignal.any([signal,lifetime.signal,localAbort.signal]);let failed=false;
      const key=JSON.stringify([location.origin,location.pathname,conf.title,conf.chapter,conf.glossary]);if(key!==chapterKey){chapterKey=key;priorSummary=conf.priorSummary;}
      const limit=['google-web','chrome'].includes(conf.backend)?conf.pageConcurrency:1;
      const operation=runPool(images,limit,async(image,index)=>{
        if(image.dataset.comicResult)return;
        if(location.href!==chapterUrl||!image.isConnected)throw new Error('漫畫頁已變更，請重新啟動章節翻譯');
        const existing=activeImages.get(image);if(existing){await existing;return;}
        const jobId=crypto.randomUUID(),started=performance.now(),progress=(d:Diagnostic)=>report({...d,jobId,pageIndex:index});
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
            controller.throwIfAborted();page=await loadSession(blob,{...conf,priorSummary},controller);
            await processSession(page,{progress,signal:controller,canTranslate:()=>!failed,onFailure:()=>{failed=true;}});
            controller.throwIfAborted();if(location.href!==chapterUrl||!image.isConnected||(original.get(image)??imageSource(image))!==source)throw new Error('漫畫頁或圖片已變更，已存文字保留');
            progress({stage:'rendering',message:'嵌字及 PNG 編碼'});const renderStarted=performance.now(),data=await encodeSession(page);progress({stage:'rendering',message:'嵌字及 PNG 完成',ms:performance.now()-renderStarted});controller.throwIfAborted();if(!live)return;
            applyImage(image,data);image.dataset.comicReview=String(page.regions.filter(r=>r.needsReview||r.warnings.some(w=>/^原文清除需校正|^中文空間不足/.test(w))).length);
            if(limit===1)priorSummary=page.regions.map(r=>r.translation).filter(Boolean).join('\n').slice(-1200);
            progress({stage:'complete',message:'本張完成並已呈現',ms:performance.now()-started});complete();
          }catch(error){
            if(!(error instanceof DeferredTranslationError))failed=true;
            image.dataset.comicError=error instanceof Error?error.message:String(error);
            if(error instanceof Error&&Object.isExtensible(error))Object.assign(error,{pageIndex:index,jobId});
            progress({stage:controller.aborted?'cancelled':'error',message:image.dataset.comicError});
            if(/out of memory|allocation failed|memory access out of bounds|gpu.*lost/i.test(image.dataset.comicError)){
              const current=await settings();await saveSettings({...current,pageConcurrency:1});image.dataset.comicError+='；已改為一張模式，續翻可恢復';
            }
            throw error;
          }finally{page?.dispose();controller.removeEventListener('abort',cancelWaiting);release();}
        };
        activeSources.set(image,original.get(image)??imageSource(image));
        const task=work();activeImages.set(image,task);try{await task;}finally{activeImages.delete(image);activeSources.delete(image);}
      },{stopped,signal:controller,failed:()=>failed});
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
    async function open(image: HTMLImageElement, auto = false, report?:(diagnostic:Diagnostic)=>void) {
      if(!auto&&batchRunning)return;
      delete image.dataset.comicError;
      const source = original.get(image) ?? imageSource(image);
      const input: {imageUrl?:string;base64?:string;mime?:string} = /^https?:/.test(source) ? {imageUrl:source} : await bytes(image);
      const conf = await settings(), key = JSON.stringify([location.origin, location.pathname, conf.title, conf.chapter, conf.glossary]);
      if (key !== chapterKey) { priorSummary = conf.priorSummary; chapterKey = key; }
      if(!auto)closeDialog?.();
      const holder=document.createElement('div');holder.setAttribute('data-comic-studio','');
      holder.style.cssText=auto?'display:none':'position:fixed;inset:20px;z-index:2147483647;background:#f1eee6;box-shadow:0 0 0 30px #0008;border-radius:12px;overflow:auto;';
      const shadow=holder.attachShadow({mode:'open'}), container=document.createElement('div');
      container.style.cssText='background:#f1eee6;color:#25362f;font:14px "Microsoft JhengHei",sans-serif;padding-top:24px;';
      const pager=document.createElement('div');
      if(!auto){
        const pages=chapterImages(),index=Math.max(0,pages.indexOf(image));
        pager.style.cssText='padding:35px 28px 0;font:13px sans-serif;color:#284e3c;';
        const heading=document.createElement('strong');heading.textContent=`章節圖片 · ${pages.length} 張`;
        const select=document.createElement('select');select.setAttribute('aria-label','切換章節圖片');select.style.cssText='margin-left:12px;padding:7px;';
        pages.forEach((page,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`第 ${i+1} 張${page.dataset.comicResult?' · 已完成':''}${page.dataset.comicError?' · 有錯誤':''}`;select.append(option);});select.value=String(index);select.onchange=()=>{const next=pages[Number(select.value)];if(next)detached(()=>open(next));};
        pager.append(heading,select);
        for(const [name,next]of [['上一張',index-1],['下一張',index+1]] as const){const button=document.createElement('button');button.type='button';button.textContent=name;button.style.cssText='margin-left:8px;padding:7px;';button.dataset.outside=String(next<0||next>=pages.length);button.disabled=button.dataset.outside==='true';button.onclick=()=>{if(pages[next])detached(()=>open(pages[next]));};pager.append(button);}
        const gallery=document.createElement('div');gallery.setAttribute('aria-label','章節全部圖片');gallery.style.cssText='display:flex;gap:6px;overflow:auto;padding:10px 0;';
        pages.forEach((page,i)=>{const button=document.createElement('button');button.type='button';button.title=`開啟第 ${i+1} 張漫畫`;button.setAttribute('aria-label',button.title);button.style.cssText='flex:0 0 68px;padding:4px;border:1px solid #aec4b2;background:white;cursor:pointer;';const thumbnail=document.createElement('img');thumbnail.src=original.get(page)??imageSource(page);thumbnail.style.cssText='width:56px;height:70px;object-fit:contain;display:block;';thumbnail.alt=`第 ${i+1} 張`;button.append(thumbnail,document.createTextNode(String(i+1)));button.onclick=()=>detached(()=>open(page));gallery.append(button);});pager.append(gallery);shadow.append(pager);
      }
      shadow.append(container);shadow.addEventListener('click',event=>event.stopPropagation());shadow.addEventListener('keydown',event=>event.stopPropagation());
      (document.body??document.documentElement).append(holder);if(!auto)dialog=holder;
      return new Promise<void>(resolve => {
        let closed=false;
        const close=()=>{if(closed)return;closed=true;void unmount(component).catch(()=>{});holder.remove();if(dialog===holder){dialog=undefined;closeDialog=undefined;}resolve();};
        const component=mount(Reader,{target:container,props:{siteInput:{...input,auto,priorSummary},onSiteProgress:report,onSiteBusy:busy=>{for(const control of pager.querySelectorAll('button,select'))(control as HTMLButtonElement).disabled=busy||(control as HTMLElement).dataset.outside==='true';},onSiteReview:count=>{image.dataset.comicReview=String(count);},onSiteSummary:summary=>{if(auto)priorSummary=summary;},onSiteApply:data=>{
            applyImage(image,data);
            if(auto)close();
          },onSiteError:error=>{image.dataset.comicError=error;if(auto)close();}}});
        if(!auto){const button=document.createElement('button');button.type='button';button.textContent='關閉工作台';button.style.cssText='position:absolute;right:15px;top:5px;z-index:2;font:14px sans-serif;padding:6px 10px;cursor:pointer';button.onclick=close;shadow.append(button);closeDialog=close;}
        ctx.onInvalidated(close);
      });
    }
    async function drain() {
      if (!live||translating || batchRunning) return; translating = true;
      try {
        while (queue.size) {
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
        const container=document.createElement('div');shadow.append(container);(document.body??document.documentElement).append(dock);
        const component=mount(ChapterDock,{target:container,props:{getImages:()=>chapterImages(),onRunning:running=>batchRunning=running,runChapter:runImages,openChapter:()=>{const images=chapterImages();const next=images.find(i=>i.dataset.comicError)||images[0];if(next)detached(()=>open(next));},toggleOriginal:()=>{const images=chapterImages().filter(i=>i.dataset.comicResult);const showRaw=images.some(i=>i.src===i.dataset.comicResult);for(const image of images){const raw=original.get(image)||image.dataset.comicOriginal;if(raw&&image.dataset.comicResult){image.srcset='';image.src=showRaw?raw:image.dataset.comicResult;}}}}});disposeDock=()=>{void unmount(component).catch(()=>{});dock?.remove();};ctx.onInvalidated(disposeDock);
      }
      for (const image of pages) {
        if (known.has(image) || image.naturalWidth < 300 || image.naturalHeight < 300) continue;
        known.add(image); observer.observe(image);
        const trigger = document.createElement('button');trigger.setAttribute('data-comic-trigger',''); trigger.type = 'button'; trigger.textContent = '墨譯'; trigger.title = '翻譯／校正這張漫畫';
        trigger.style.cssText = 'position:fixed;display:none;z-index:2147483646;background:#284e3c;color:white;border:0;border-radius:14px;padding:7px 13px;font:13px sans-serif;cursor:pointer';
        const show = () => { const rect = image.getBoundingClientRect(); trigger.style.left = Math.max(4, Math.min(innerWidth - 65, rect.right - 60)) + 'px'; trigger.style.top = Math.max(4, rect.top + 8) + 'px'; trigger.style.display = 'block'; };
        let timer:ReturnType<typeof setTimeout>|undefined;const leave=()=>{timer=setTimeout(()=>{if(!trigger.matches(':hover'))trigger.style.display='none';},180);};image.addEventListener('mouseenter',show);image.addEventListener('mouseleave',leave);eventDisposers.push(()=>{image.removeEventListener('mouseenter',show);image.removeEventListener('mouseleave',leave);if(timer)clearTimeout(timer);});
        trigger.onmouseleave = () => { trigger.style.display = 'none'; };
        trigger.onclick = event => { event.preventDefault(); event.stopImmediatePropagation(); trigger.textContent = '墨譯'; detached(()=>open(image),e=>{image.dataset.comicError=String(e);trigger.textContent='讀取失敗';trigger.title=String(e);}); };
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
        if (image.currentSrc !== processed.get(image)) { if(activeImages.has(image))runAbort?.abort(new DOMException('漫畫圖片已變更','AbortError'));original.delete(image); processed.delete(image);if(image.dataset.comicResult)URL.revokeObjectURL(image.dataset.comicResult);delete image.dataset.comicOriginal;delete image.dataset.comicResult;delete image.dataset.comicReview;if (image.complete) { queue.add(image); detached(async()=>{const conf=await settings();if(conf.auto)await drain();}); } }
      }
      scan();
    });
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    document.addEventListener('load', scan, true); scan();
    const navigation=()=>runAbort?.abort(new DOMException('漫畫頁已變更','AbortError'));addEventListener('popstate',navigation);eventDisposers.push(()=>removeEventListener('popstate',navigation));
    const receive=(message:any)=>{if(live&&message.channel==='open-image'){const image=[...document.images].find(i=>i.currentSrc===message.url||original.get(i)===message.url);if(image)detached(()=>open(image));}};
    detached(()=>chrome.runtime.onMessage.addListener(receive));
    const cleanup=()=>{
      if(!live)return;live=false;lifetime.abort();observer.disconnect();mutations.disconnect();queue.clear();document.removeEventListener('load',scan,true);
      for(const dispose of eventDisposers)dispose();closeDialog?.();disposeDock?.();dock?.remove();
      for(const trigger of document.querySelectorAll('[data-comic-trigger]'))trigger.remove();
      if(contextAlive())detached(()=>chrome.runtime.onMessage.removeListener(receive));
      const notice=document.createElement('div');notice.setAttribute('role','status');notice.setAttribute('data-comic-updated','');notice.textContent='墨譯已更新，請重新整理漫畫頁後續翻；完成圖片已保留';notice.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483646;background:#f3f3eb;color:#253d30;border:1px solid #8ba391;border-radius:8px;padding:12px;font:13px sans-serif';(document.body??document.documentElement).append(notice);
    };
    onContextInvalidated(cleanup);ctx.onInvalidated(()=>{cleanup();invalidateContext();});
    eventDisposers.push(watchExtensionContext());
  },
});
