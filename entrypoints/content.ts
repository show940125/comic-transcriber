import { defineContentScript } from 'wxt/utils/define-content-script';
import { settings } from '../src/storage';
import { imageBase64 } from '../src/binary';
import { mount, unmount } from 'svelte';
import Reader from '../src/Reader.svelte';
import ChapterDock from '../src/ChapterDock.svelte';
import { chapterImages, imageSource } from '../src/site-images';
import type { Diagnostic } from '../src/types';
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'], runAt: 'document_idle',
  main(ctx) {
    const original = new WeakMap<HTMLImageElement, string>(), processed = new WeakMap<HTMLImageElement, string>();
    const known = new WeakSet<HTMLImageElement>(), queue = new Set<HTMLImageElement>();
    let translating = false, dialog: HTMLDivElement | undefined, priorSummary = '', chapterKey = '';
    let closeDialog: (()=>void) | undefined;
    let batchRunning=false, dock:HTMLDivElement|undefined;
    async function bytes(image: HTMLImageElement) {
      const url = original.get(image) ?? image.currentSrc;
      try { const res = await fetch(url,{signal:AbortSignal.timeout(10000)}); if (!res.ok) throw new Error('圖片讀取失敗'); const blob = await res.blob(); if (!blob.type.startsWith('image/') || blob.size > 20 * 1024 * 1024) throw new Error('圖片格式或大小不支援'); return { base64: imageBase64(new Uint8Array(await blob.arrayBuffer())), mime: blob.type }; }
      catch (error) {
        if (url.startsWith('blob:') || url.startsWith('data:')) throw error;
        const response = await chrome.runtime.sendMessage({ channel: 'fetch-image', url }); if (!response.ok) throw new Error(response.error); return response;
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
        pages.forEach((page,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`第 ${i+1} 張${page.dataset.comicResult?' · 已完成':''}${page.dataset.comicError?' · 有錯誤':''}`;select.append(option);});select.value=String(index);select.onchange=()=>{const next=pages[Number(select.value)];if(next)void open(next).catch(console.warn);};
        pager.append(heading,select);
        for(const [name,next]of [['上一張',index-1],['下一張',index+1]] as const){const button=document.createElement('button');button.type='button';button.textContent=name;button.style.cssText='margin-left:8px;padding:7px;';button.dataset.outside=String(next<0||next>=pages.length);button.disabled=button.dataset.outside==='true';button.onclick=()=>{if(pages[next])void open(pages[next]).catch(console.warn);};pager.append(button);}
        const gallery=document.createElement('div');gallery.setAttribute('aria-label','章節全部圖片');gallery.style.cssText='display:flex;gap:6px;overflow:auto;padding:10px 0;';
        pages.forEach((page,i)=>{const button=document.createElement('button');button.type='button';button.title=`開啟第 ${i+1} 張漫畫`;button.setAttribute('aria-label',button.title);button.style.cssText='flex:0 0 68px;padding:4px;border:1px solid #aec4b2;background:white;cursor:pointer;';const thumbnail=document.createElement('img');thumbnail.src=original.get(page)??imageSource(page);thumbnail.style.cssText='width:56px;height:70px;object-fit:contain;display:block;';thumbnail.alt=`第 ${i+1} 張`;button.append(thumbnail,document.createTextNode(String(i+1)));button.onclick=()=>void open(page).catch(console.warn);gallery.append(button);});pager.append(gallery);shadow.append(pager);
      }
      shadow.append(container);shadow.addEventListener('click',event=>event.stopPropagation());shadow.addEventListener('keydown',event=>event.stopPropagation());
      document.documentElement.append(holder);if(!auto)dialog=holder;
      return new Promise<void>(resolve => {
        let closed=false;
        const close=()=>{if(closed)return;closed=true;void unmount(component);holder.remove();if(dialog===holder){dialog=undefined;closeDialog=undefined;}resolve();};
        const component=mount(Reader,{target:container,props:{siteInput:{...input,auto,priorSummary},onSiteProgress:report,onSiteBusy:busy=>{for(const control of pager.querySelectorAll('button,select'))(control as HTMLButtonElement).disabled=busy||(control as HTMLElement).dataset.outside==='true';},onSiteReview:count=>{image.dataset.comicReview=String(count);},onSiteSummary:summary=>{if(auto)priorSummary=summary;},onSiteApply:data=>{
            original.set(image, original.get(image) ?? imageSource(image));image.dataset.comicOriginal=original.get(image);
            const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
            const old = image.dataset.comicResult; if (old) URL.revokeObjectURL(old);
            image.dataset.comicResult = url; image.srcset = ''; image.src = url;
            image.loading='eager';image.removeAttribute('data-src');image.removeAttribute('data-original');
            processed.set(image, url);
            image.title = '墨譯繁中頁面；按墨譯可校正，雙擊圖片切換原圖';
            if(auto)close();
          },onSiteError:error=>{image.dataset.comicError=error;if(auto)close();}}});
        if(!auto){const button=document.createElement('button');button.type='button';button.textContent='關閉工作台';button.style.cssText='position:absolute;right:15px;top:5px;z-index:2;font:14px sans-serif;padding:6px 10px;cursor:pointer';button.onclick=close;shadow.append(button);closeDialog=close;}
        ctx.onInvalidated(close);
      });
    }
    async function drain() {
      if (translating || batchRunning) return; translating = true;
      try {
        while (queue.size) {
          const images = [...queue].sort((a, b) => Math.abs(a.getBoundingClientRect().top) - Math.abs(b.getBoundingClientRect().top));
          const image = images[0]; queue.delete(image);
          if (!image.isConnected || image.dataset.comicResult || !image.complete) continue;
          const conf = await settings(); if (!conf.auto) break;
          // Only one page runs at a time. Within the margin, nearest pages are prioritized.
          try { await open(image, true); } catch (e) { image.dataset.comicError = String(e); }
        }
      } finally { translating = false; }
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) queue.add(entry.target as HTMLImageElement);
      void settings().then(conf => { if (conf.auto) void drain(); else queue.clear(); });
    }, { rootMargin: '800px' });
    function scan() {
      const pages=chapterImages();
      if(pages.length&&!dock){
        dock=document.createElement('div');dock.setAttribute('data-comic-dock','');dock.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483646;';
        const shadow=dock.attachShadow({mode:'open'});shadow.addEventListener('click',event=>event.stopPropagation());
        const container=document.createElement('div');shadow.append(container);document.documentElement.append(dock);
        const component=mount(ChapterDock,{target:container,props:{getImages:()=>chapterImages(),onRunning:running=>batchRunning=running,translateImage:async(image,progress)=>{if(translating)throw new Error('自動佇列正在處理圖片，請稍候再啟動章節翻譯');await open(image,true,progress);if(image.dataset.comicError)throw new Error(`${image.dataset.comicError} 可在章節工作台校正或授權圖片來源。`);},openChapter:()=>{const images=chapterImages();const next=images.find(i=>i.dataset.comicError)||images[0];if(next)void open(next).catch(console.warn);},toggleOriginal:()=>{const images=chapterImages().filter(i=>i.dataset.comicResult);const showRaw=images.some(i=>i.src===i.dataset.comicResult);for(const image of images){const raw=original.get(image)||image.dataset.comicOriginal;if(raw&&image.dataset.comicResult){image.srcset='';image.src=showRaw?raw:image.dataset.comicResult;}}}}});ctx.onInvalidated(()=>{void unmount(component);dock?.remove();});
      }
      for (const image of pages) {
        if (known.has(image) || image.naturalWidth < 300 || image.naturalHeight < 300) continue;
        known.add(image); observer.observe(image);
        const trigger = document.createElement('button'); trigger.type = 'button'; trigger.textContent = '墨譯'; trigger.title = '翻譯／校正這張漫畫';
        trigger.style.cssText = 'position:fixed;display:none;z-index:2147483646;background:#284e3c;color:white;border:0;border-radius:14px;padding:7px 13px;font:13px sans-serif;cursor:pointer';
        const show = () => { const rect = image.getBoundingClientRect(); trigger.style.left = Math.max(4, Math.min(innerWidth - 65, rect.right - 60)) + 'px'; trigger.style.top = Math.max(4, rect.top + 8) + 'px'; trigger.style.display = 'block'; };
        image.addEventListener('mouseenter', show); image.addEventListener('mouseleave', () => { setTimeout(() => { if (!trigger.matches(':hover')) trigger.style.display = 'none'; }, 180); });
        trigger.onmouseleave = () => { trigger.style.display = 'none'; };
        trigger.onclick = event => { event.preventDefault(); event.stopImmediatePropagation(); trigger.textContent = '墨譯'; void open(image).catch(e => { image.dataset.comicError = String(e); trigger.textContent = '讀取失敗'; trigger.title = String(e); }); };
        image.addEventListener('dblclick', () => { const raw = original.get(image), result = image.dataset.comicResult; if (raw && result) { image.src = image.src === result ? raw : result; processed.set(image, image.currentSrc); } });
        document.documentElement.append(trigger); ctx.onInvalidated(() => trigger.remove());
      }
    }
    const mutations = new MutationObserver(records => {
      for (const record of records) if (record.type === 'attributes' && record.target instanceof HTMLImageElement) {
        const image = record.target;
        if (image.dataset.comicResult === image.src || image.src === (original.get(image)??image.dataset.comicOriginal)) continue;
        if (image.currentSrc !== processed.get(image)) { original.delete(image); processed.delete(image); if (image.complete) { queue.add(image); void settings().then(conf => { if (conf.auto) void drain(); }); } }
      }
      scan();
    });
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    document.addEventListener('load', scan, true); scan();
    chrome.runtime.onMessage.addListener((message) => { if (message.channel === 'open-image') { const image = [...document.images].find(i => i.currentSrc === message.url || original.get(i) === message.url); if (image) void open(image).catch(e => console.warn('墨譯', String(e))); } });
    ctx.onInvalidated(() => { observer.disconnect(); mutations.disconnect(); document.removeEventListener('load', scan, true); });
  },
});
