<script lang="ts">
  import { onMount } from 'svelte';
  import { defaults, type Region, type Settings, type Diagnostic, type PageData } from './types';
  import { engine } from './runtime';
  import { hashBlob, readingOrder, clampRegion, localUrl, contentSignature, importCorrection } from './core';
  import { loadPage, cachePage, settings as readSettings } from './storage';
  import { renderPage, loadFont } from './render';
  import { chromeTranslate,prepareChromeTranslator,disposeChromeTranslator } from './chrome-translator';
  import { googleWebTranslate, googleWebOrigin } from './google-web';
  import { needsOcrReview, ocrReviewWarning } from './ocr-quality';
  import { imageBytes } from './binary';
  import { publicImageUrl } from './core';
  let { siteInput, onSiteApply, onSiteError, onSiteSummary, onSiteProgress, onSiteBusy, onSiteReview }: {
    siteInput?: {base64?:string; mime?:string; imageUrl?:string; auto?:boolean; priorSummary?:string};
    onSiteApply?: (bytes:Uint8Array<ArrayBuffer>)=>void;
    onSiteError?: (error:string)=>void;
    onSiteSummary?: (summary:string)=>void;
    onSiteProgress?: (diagnostic:Diagnostic)=>void;
    onSiteBusy?: (busy:boolean)=>void;
    onSiteReview?: (count:number)=>void;
  } = $props();
  let config = $state<Settings>({ ...defaults }), blob: Blob | undefined;
  let image = $state<HTMLImageElement | undefined>();
  let regions = $state<Region[]>([]), selected = $state(''), hash = '', busy = $state(false), original = $state(false);
  let message = $state('選一張漫畫，從文字框開始。'), error = $state(''), diagnostics = $state<Diagnostic[]>([]);
  let stage = $state('idle'), preview: HTMLDivElement, canvas = $state<HTMLCanvasElement | undefined>();
  let drawing = $state(false), filename = $state('comic'), aborter: AbortController | undefined;
  let gpu = $state<{ available: boolean; f16: boolean } | undefined>(), drawingStart: { x: number; y: number } | undefined;
  let fontReady = $state(false), imageUrl = '', signature = '';
  let remoteImageUrl = $state(''), permissionOrigin = $state('');
  async function loadRemote() {
    if (!remoteImageUrl) return;
    const response = await chrome.runtime.sendMessage({ channel:'fetch-image', url:remoteImageUrl });
    if (!response?.ok) {
      permissionOrigin = response?.permissionOrigin ?? '';
      throw new Error(response?.error ?? '圖片讀取失敗，請重試');
    }
    permissionOrigin = '';
    const bytes = typeof response.base64 === 'string' ? imageBytes(response.base64) : new Uint8Array(response.bytes);
    await load(new Blob([bytes], {type:response.mime}), 'web-comic');
  }
  async function grantImage() {
    // Invoke synchronously in the actual button click before any awaited work.
    const grant = siteInput ? chrome.runtime.sendMessage({channel:'grant-image',origin:permissionOrigin}).then(r=>{if(r.error)throw new Error(r.error);return r.ok;}) : chrome.permissions.request({ origins:[permissionOrigin] });
    await action(async () => {
      if (!await grant) throw new Error('圖片來源授權未核准；可重新授權或選擇本機圖片');
      await loadRemote();
    });
  }
  const active = $derived(regions.find(r => r.id === selected));
  const modelId = () => `Qwen3.5-${config.model === '2b' ? '2B' : '0.8B'}-q4f${gpu?.f16 ? '16' : '32'}_1-MLC`;
  function progress(d: Diagnostic) { message = d.message; stage = d.stage; diagnostics = [...diagnostics.slice(-99), d]; onSiteProgress?.(d); }
  function paint() {
    if (!image || !preview) return;
    canvas = renderPage(image, regions, original); canvas.setAttribute('aria-label', '漫畫預覽');
    preview.replaceChildren(canvas);
  }
  async function action(work: () => Promise<void>) {
    if (busy) return; busy = true; onSiteBusy?.(true); error = ''; aborter = new AbortController();
    try { await work(); }
    catch (e) { const cancelled=aborter.signal.aborted;error=cancelled?'已取消目前操作，完成部分已保留':e instanceof Error?e.message:String(e);stage=cancelled?'cancelled':'error';if(cancelled)progress({stage:'cancelled',message:error,cause:'cancel'});onSiteError?.(error);if(parent!==window)parent.postMessage({channel:'comic-error',token:location.hash.slice(1),error},'*'); }
    finally { busy = false; onSiteBusy?.(false); paint(); }
  }
  async function save() {
    if (!image || !hash) return;
    const page: PageData = { schema: 1, hash, width: image.naturalWidth, height: image.naturalHeight, regions: $state.snapshot(regions), title: config.title, chapter: config.chapter, glossary: config.glossary, summary: regions.filter(r => r.translation).map(r => r.translation).join('\n').slice(0, 1500), modelKey: signature };
    await cachePage(page);
  }
  async function load(input: Blob, name = 'comic') {
    if (input.size > 20 * 1024 * 1024 || !input.type.startsWith('image/')) throw new Error('請使用 20 MB 以內的圖片');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(input); const next = new Image(); next.src = imageUrl; await next.decode();
    if (next.naturalWidth * next.naturalHeight > 30_000_000) throw new Error('圖片超過 3000 萬像素，請先裁切');
    image = next; blob = input; filename = name; hash = await hashBlob(input); signature = contentSignature(config);
    const cached = await loadPage(hash, signature); regions = (cached?.regions??[]).map(r=>({...r,ocrDone:r.ocrDone??(!!r.source.trim()||r.warnings.some(w=>/疑似無文字|缺少日文字元/.test(w)))})); selected = ''; original = false;
    message = cached ? '已載入圖片與先前校正' : '圖片已載入，按「偵測文字框」或手動框選'; stage = cached ? 'complete' : 'idle'; paint();
  }
  async function detect() {
    if (!blob || !image) return;
    regions = await engine({ op: 'detect', image: blob, width: image.naturalWidth, height: image.naturalHeight }, progress, aborter?.signal);
    selected = regions[0]?.id ?? ''; await save();
  }
  async function ocr() {
    if (!blob) return;
    if (config.localOcr) {
      const output=await engine({op:'local-ocr',image:blob,regions:$state.snapshot(regions),endpoint:localUrl(config.ocrEndpoint)},progress,aborter?.signal);
      if (!Array.isArray(output.regions) || output.regions.length !== regions.length || output.regions.some((r: any, i: number) => r.id !== regions[i].id || typeof r.source !== 'string')) throw new Error('本機 OCR 結果格式錯誤');
      regions = regions.map((r, i) => ({ ...r, source: output.regions[i].source, translation:'', ocrDone:true, needsReview:needsOcrReview(output.regions[i].source), warnings:[...(output.regions[i].warnings ?? r.warnings),...(needsOcrReview(output.regions[i].source)?[ocrReviewWarning]:[])] })); progress({ stage: 'ocr', message: '本機 OCR 完成', backend: output.backend, ms: output.ms });
    } else regions = await engine({ op: 'ocr', image: blob, regions: $state.snapshot(regions), provider: config.ocrProvider }, progress, aborter?.signal);
    await save();
  }
  async function translate() {
    if (!regions.some(r => r.source.trim()&&!r.needsReview)) throw new Error('請先 OCR，並核對原文辨識警示；可在原文欄修正日文');
    if (config.backend === 'google-web') {
      if (!siteInput && !await chrome.permissions.contains({ origins: [googleWebOrigin] })) throw new Error('請先在設定選 Google 免金鑰網頁翻譯並儲存，以授權文字請求');
      const transport:typeof fetch=async (input,init)=>{
        init?.signal?.throwIfAborted();
        const source=new URL(String(input)).searchParams.get('q');
        const result=await chrome.runtime.sendMessage({channel:'google-text',source});
        init?.signal?.throwIfAborted();
        if(!result?.ok)throw new Error(result?.error??'Google 翻譯請求未回應');
        return new Response(JSON.stringify(result.data),{status:result.status,headers:{'content-type':'application/json'}});
      };
      try { regions = await googleWebTranslate($state.snapshot(regions), progress, aborter?.signal, siteInput?transport:fetch,{onPartial:async partial=>{regions=partial;signature=contentSignature(config);await save();paint();}}); }
      catch(error) {
        if (!config.localFallback || aborter?.signal.aborted) throw error;
        progress({stage:'translating',message:`${error instanceof Error?error.message:String(error)} 使用已啟用的本機備援。`,backend:'local-http',model:config.localModel});
        regions = await engine({op:'translate',regions:$state.snapshot(regions),settings:{...$state.snapshot(config),backend:'local'},modelId:''},progress,aborter?.signal);
      }
    } else if (config.backend === 'chrome') regions = await chromeTranslate($state.snapshot(regions), progress, aborter?.signal);
    else {
      if(config.backend==='webllm'&&!gpu)gpu=await engine({op:'probe'},progress,aborter?.signal);
      regions = await engine({ op: 'translate', regions: $state.snapshot(regions), settings: $state.snapshot(config), modelId: modelId() }, progress, aborter?.signal);
    }
    signature = contentSignature(config); await save();
  }
  async function translatePage() {
    if (!image) return;
    original=false;
    if(config.backend==='chrome')await prepareChromeTranslator(progress,aborter?.signal);
    if (!regions.length) await detect();
    if (!regions.length) {message='此頁未找到文字；可手動框選';return;}
    if (regions.some(r=>!r.source.trim()&&!r.ocrDone)) await ocr();
    if (regions.some(r=>r.source.trim()&&!r.needsReview&&!r.translation.trim())) await translate();
    else if(regions.some(r=>r.needsReview))progress({stage:'review',message:'原文有辨識疑慮，請核對警示；其餘譯文已保留'});
    else progress({stage:'complete',message:'已載入完成的譯文；可直接校正或匯出'});
  }
  async function applyToPage() {
    if (!image) return;
    const result = renderPage(image, regions, false);
    const png = await new Promise<Blob>((resolve, reject) => result.toBlob(b => b ? resolve(b) : reject(new Error('PNG 編碼失敗')), 'image/png'));
    if(onSiteApply){onSiteSummary?.(regions.map(r=>r.translation).filter(Boolean).join('\n').slice(-1200));onSiteReview?.(regions.filter(r=>r.needsReview).length);onSiteApply(new Uint8Array(await png.arrayBuffer()));message='已套用至漫畫頁';return;}
    parent.postMessage({ channel: 'comic-result', token: location.hash.slice(1), summary: regions.map(r => r.translation).filter(Boolean).join('\n').slice(-1200), bytes: [...new Uint8Array(await png.arrayBuffer())] }, '*');
  }
  function point(event: PointerEvent) {
    const rect = preview.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (image?.naturalWidth ?? 1) / rect.width, y: (event.clientY - rect.top) * (image?.naturalHeight ?? 1) / rect.height };
  }
  function down(event: PointerEvent) { if (drawing && image && !busy) { drawingStart = point(event); preview.setPointerCapture(event.pointerId); } }
  function up(event: PointerEvent) {
    if (!drawingStart || !image) return;
    const end = point(event), start = drawingStart; drawingStart = undefined;
    if (Math.abs(end.x - start.x) < 4 || Math.abs(end.y - start.y) < 4) return;
    const r = clampRegion({ id: crypto.randomUUID(), x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y), source: '', translation: '', order: regions.length, score: 1, warnings: ['人工框選'], kind: 'bubble', render: 'auto' }, image.naturalWidth, image.naturalHeight);
    regions = readingOrder([...regions, r]); selected = r.id; drawing = false; paint(); void save();
  }
  function update(field: keyof Region, value: unknown) {
    if (!image) return;
    regions = regions.map(r => r.id === selected ? clampRegion({ ...r, ...(['x','y','width','height'].includes(field) ? { ocrBox: undefined } : {}), ...(field==='source'?{ocrDone:!!String(value).trim(),translation:value!==r.source?'':r.translation,needsReview:needsOcrReview(String(value)),warnings:[...r.warnings.filter(w=>w!==ocrReviewWarning),...(needsOcrReview(String(value))?[ocrReviewWarning]:[])]}:{}), [field]: value }, image!.naturalWidth, image!.naturalHeight) : r); paint(); void save();
  }
  function remove() { regions = regions.filter(r => r.id !== selected); selected = regions[0]?.id ?? ''; paint(); void save(); }
  function merge() {
    const a = active, b = regions.find(r => r.order === (a?.order ?? -2) + 1); if (!a || !b) return;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const r = { ...a, ocrBox: undefined, x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y, source: a.source + b.source, translation: [a.translation, b.translation].filter(Boolean).join('\n') };
    regions = regions.filter(v => v.id !== b.id).map(v => v.id === a.id ? r : v); paint(); void save();
  }
  function exportJson() { if (!image) return; download(new Blob([JSON.stringify({ schema: 1, hash, width: image.naturalWidth, height: image.naturalHeight, regions: $state.snapshot(regions), diagnostics }, null, 2)], { type: 'application/json' }), `${filename}.json`); }
  function download(data: Blob, name: string) { const url = URL.createObjectURL(data), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  onMount(() => {
    let alive=true;
    const token = location.hash.slice(1);
    let allowedOrigin = '';
    const receive = (event: MessageEvent) => {
      if (event.source !== parent || !allowedOrigin || event.origin !== allowedOrigin || !token || event.data?.token !== token || event.data?.channel !== 'comic-image') return;
      if (typeof event.data.imageUrl === 'string') {
        try { remoteImageUrl = publicImageUrl(event.data.imageUrl).href; } catch { return; }
        void action(loadRemote); return;
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        if (typeof event.data.base64 === 'string') bytes = imageBytes(event.data.base64);
        else if (Array.isArray(event.data.bytes) && event.data.bytes.length <= 20 * 1024 * 1024) bytes = new Uint8Array(event.data.bytes);
        else return;
      } catch { return; }
      void action(async () => { if (event.data.auto && typeof event.data.priorSummary === 'string') config.priorSummary = event.data.priorSummary; await load(new Blob([bytes], { type: event.data.mime }), 'web-comic'); if (event.data.auto) { await translatePage(); await applyToPage(); } });
    };
    addEventListener('message', receive);
    const stop = () => {aborter?.abort();disposeChromeTranslator();}; addEventListener('pagehide', stop);
    void (async () => { config = await readSettings(); if (token && parent !== window) { const authority = await chrome.runtime.sendMessage({ channel: 'frame-authority', token }); if (authority?.ok) allowedOrigin = authority.origin; else { error = '未授權的嵌入工作台，請從墨譯按鈕開啟'; return; } } try { await loadFont(!!siteInput); fontReady = true; } catch { error = '繁中字型載入失敗，暫用系統字型'; } if (allowedOrigin) parent.postMessage({ channel: 'comic-ready', token }, allowedOrigin);
      if(alive&&siteInput)void action(async()=>{if(siteInput.priorSummary)config.priorSummary=siteInput.priorSummary;if(siteInput.imageUrl){remoteImageUrl=publicImageUrl(siteInput.imageUrl).href;await loadRemote();}else if(siteInput.base64)await load(new Blob([imageBytes(siteInput.base64)],{type:siteInput.mime}),'web-comic');if(siteInput.auto){await translatePage();await applyToPage();}});
    })();
    return () => { alive=false;stop(); removeEventListener('pagehide', stop); removeEventListener('message', receive); if (imageUrl) URL.revokeObjectURL(imageUrl); };
  });
</script>

<svelte:head>{#if !siteInput}<title>墨譯 · 漫畫工作台</title>{/if}</svelte:head>
<main>
  <header><div><span class="eyebrow">LOCAL COMIC STUDIO</span><h1>墨譯<span>漫畫工作台</span></h1></div>{#if siteInput}<button onclick={()=>chrome.runtime.sendMessage({channel:'open-options'})}>模型與閱讀設定 ↗</button>{:else}<a href="options.html" target="_blank">模型與閱讀設定 ↗</a>{/if}</header>
  <section class="toolbar" aria-label="操作工具">
    <label class="file">選擇圖片<input type="file" accept="image/*" disabled={busy} onchange={e => { const file = e.currentTarget.files?.[0]; if (file) void action(() => load(file, file.name.replace(/\.[^.]+$/, ''))); }} /></label>
    <button class="primary" disabled={!image || busy} onclick={() => action(translatePage)}>一鍵翻譯</button>
    <button disabled={!image || busy} onclick={() => action(detect)}>1 偵測文字框</button>
    <button disabled={!regions.length || busy} onclick={() => action(ocr)}>2 辨識日文</button>
    <button class="primary" disabled={!regions.length || busy} onclick={() => action(translate)}>3 翻譯繁中</button>
    <button disabled={!image || busy} class:chosen={drawing} onclick={() => drawing = !drawing}>手動框選</button>
    <button disabled={!image} onclick={() => { original = !original; paint(); }}>{original ? '顯示譯文' : '切回原圖'}</button>
    <label class="file">載入校正<input aria-label="載入校正 JSON" type="file" accept="application/json,.json" disabled={!image || busy} onchange={e => { const file=e.currentTarget.files?.[0];if(file&&image)void action(async()=>{if(file.size>2*1024*1024)throw new Error('校正檔超過 2 MB');regions=importCorrection(JSON.parse(await file.text()),hash,image!.naturalWidth,image!.naturalHeight);selected=regions[0]?.id??'';await save();message='校正已載入';}); }} /></label>
    {#if busy}<button onclick={() => aborter?.abort()}>取消</button>{/if}
  </section>
  <div class="status" aria-live="polite"><span class:working={busy} class="dot"></span>{message}<small>{gpu?.available ? 'WebGPU 可用' : 'WASM／本機服務'} · {fontReady ? '繁中字型就緒' : '字型載入中'}</small></div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if permissionOrigin}<section aria-label="圖片來源授權"><p>漫畫圖片由 {permissionOrigin.replace('/*','')} 提供。授權這個來源後即可在本機辨識。</p><button disabled={busy} onclick={grantImage}>授權圖片來源並重試</button></section>
  {:else if remoteImageUrl && !image}<button disabled={busy} onclick={() => action(loadRemote)}>重新讀取網站圖片</button>{/if}
  <div class="workspace">
    <section class="paper">
      {#if !image}<div class="empty"><span>墨</span><h2>把故事，讀成自己的語言。</h2><p>載入漫畫後，確認文字框、辨識日文，再翻譯成繁體中文。<br>原畫與每個步驟的文字都可以保留與校正。</p></div>{/if}
      <div class="image-wrap" class:drawing bind:this={preview} role="presentation" onpointerdown={down} onpointerup={up}></div>
      {#if image}
        <div class="regions" style={`aspect-ratio:${image.naturalWidth}/${image.naturalHeight}`}>
          {#each regions as r}<button class:selected={selected === r.id} style={`left:${r.x / image.naturalWidth * 100}%;top:${r.y / image.naturalHeight * 100}%;width:${r.width / image.naturalWidth * 100}%;height:${r.height / image.naturalHeight * 100}%`} title={`文字框 ${r.order + 1}`} aria-label={`選取文字框 ${r.order + 1}`} onclick={() => selected = r.id}><span>{r.order + 1}</span></button>{/each}
        </div>
      {/if}
    </section>
    <aside>
      <h2>文字與校正 <small>{regions.length} 個區域</small></h2>
      <select aria-label="選擇文字框" bind:value={selected}><option value="">選擇區域</option>{#each regions as r}<option value={r.id}>{r.order + 1} · {r.source.slice(0, 16) || '尚未辨識'}</option>{/each}</select>
      {#if active}
        <label>日文原文<textarea aria-label="日文原文" rows="4" value={active.source} oninput={e => update('source', e.currentTarget.value)} disabled={busy}></textarea></label>
        <label>繁中譯文<textarea aria-label="繁中譯文" rows="4" value={active.translation} oninput={e => update('translation', e.currentTarget.value)} disabled={busy}></textarea></label>
        <div class="coords">{#each ['x', 'y', 'width', 'height', 'order'] as field}<label>{({x:'X',y:'Y',width:'寬',height:'高',order:'順序'} as any)[field]}<input type="number" aria-label={field} value={(active as any)[field]} disabled={busy} oninput={e => { const n = Number(e.currentTarget.value); if (Number.isFinite(n)) update(field as keyof Region, Math.max(0, n)); }} /></label>{/each}</div>
        <label>呈現方式<select aria-label="呈現方式" value={active.render} disabled={busy} onchange={e => update('render', e.currentTarget.value)}><option value="auto">字形白底／局部遮蓋原文</option><option value="overlay">字形白底（浮層）</option><option value="rectangle">矩形浮層（舊方式）</option><option value="fill">手動確認擦成白底</option></select></label>
        {#each active.warnings as warning}<p class="warning">{warning}</p>{/each}
        <div class="row"><button disabled={busy} onclick={merge}>合併下一框</button><button disabled={busy} onclick={remove}>刪除此框</button></div>
      {:else}<p class="hint">點選圖片上的文字框；拖曳手動框選或以座標欄調整大小。</p>{/if}
      <div class="export">{#if parent !== window || onSiteApply}<button disabled={!canvas || busy} onclick={() => action(applyToPage)}>套用至漫畫頁</button>{/if}<button disabled={!canvas || busy} onclick={() => canvas?.toBlob(b => { if (b) download(b, `${filename}-translated.png`); }, 'image/png')}>匯出 PNG</button><button disabled={!image || busy} onclick={exportJson}>匯出校正 JSON</button></div>
      <details><summary>本頁執行紀錄</summary>{#each diagnostics as d}<p class="diagnostic">{d.message}<small>{d.backend ?? ''} {d.model ?? ''} {d.ms ? `${Math.round(d.ms)} ms` : ''}</small></p>{/each}</details>
      <small class="privacy">{config.backend === 'google-web' ? 'Google 網頁翻譯僅傳送 OCR 文字，圖片與嵌字留在本機。免金鑰、零 API 費。' : '目前翻譯模式在本機處理；首次使用會下載模型，本機服務僅連到設定的 localhost。'}</small>
    </aside>
  </div>
</main>

<style>
  :global(*){box-sizing:border-box} :global(body){margin:0;background:#f1eee6;color:#25362f;font-family:"Microsoft JhengHei",sans-serif} :global(button),:global(input),:global(select),:global(textarea){font:inherit}main{max-width:1480px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}h1{font-size:30px;margin:7px 0 0}h1 span{font-size:16px;font-weight:400;margin-left:15px;color:#67756c}.eyebrow{font-size:10px;letter-spacing:3px;color:#6c7c6e}a{color:#355947;font-size:13px}button,.file{border:1px solid #c8d1c7;border-radius:7px;background:#fafaf6;color:#314b3e;padding:10px 13px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary,.chosen{background:#284e3c;color:white;border-color:#284e3c}.toolbar{display:flex;gap:8px;flex-wrap:wrap}.file{position:relative;background:#e1e8dd}.file input{position:absolute;inset:0;opacity:0;width:100%;cursor:pointer}.status{display:flex;align-items:center;gap:9px;font-size:13px;padding:16px 0;flex-wrap:wrap}.status small{margin-left:auto;color:#6d7b70}.dot{height:8px;width:8px;background:#6e987c;border-radius:100%}.working{animation:pulse 1s infinite}@keyframes pulse{50%{opacity:.25}}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px;align-items:start}.paper{position:relative;background:white;min-height:550px;box-shadow:0 5px 25px #36473812}.empty{padding:100px 25px;text-align:center}.empty>span{font-size:90px;font-family:serif;color:#b8c6b8}.empty h2{font-size:23px}.empty p{font-size:14px;line-height:2;color:#768177}.image-wrap{width:100%;touch-action:none}.image-wrap :global(canvas){width:100%;height:auto;display:block}.drawing{cursor:crosshair}.regions{position:absolute;inset:0;pointer-events:none}.regions button{position:absolute;pointer-events:auto;border:1px solid #628d7080;background:transparent;border-radius:0;padding:0}.drawing+.regions{pointer-events:none}.drawing+.regions button{pointer-events:none}.regions .selected{border:2px solid #b2783e}.regions span{position:absolute;left:0;top:0;background:#355c46;color:white;font-size:10px;padding:1px 4px}aside{background:#f9f9f4;border:1px solid #d8ddd2;border-radius:10px;padding:18px}h2{font-size:16px}h2 small{font-size:11px;color:#758276}label{display:block;font-size:12px;color:#65756a;margin:15px 0 8px}textarea,input,select{display:block;width:100%;padding:8px;background:white;border:1px solid #cdd5ca;border-radius:5px;color:#263f31}textarea{resize:vertical;line-height:1.6}.coords{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.coords input{padding:6px}.row,.export{display:flex;gap:6px;flex-wrap:wrap}.export{border-top:1px solid #d8ddd2;margin-top:18px;padding-top:18px}.export button,.row button{font-size:12px}.hint{font-size:13px;line-height:1.7;color:#7b877a}.error{background:#ffe7dc;color:#8c3423;padding:12px;border-radius:5px}.warning{color:#876126;font-size:12px}.privacy{display:block;line-height:1.7;color:#798477;margin-top:20px}details{margin-top:18px;font-size:12px}.diagnostic{border-bottom:1px solid #e5e8e0;padding-bottom:7px}.diagnostic small{display:block;color:#798477;margin-top:4px}@media(max-width:850px){main{padding:14px}.workspace{grid-template-columns:1fr}.paper{min-height:300px}header{align-items:start}h1 span{display:block;margin:5px 0}aside{width:100%}}
</style>
