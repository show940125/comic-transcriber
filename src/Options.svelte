<script lang="ts">
  import { onMount,tick } from 'svelte';
  import { defaults, type Settings } from './types';
  import { settings, saveSettings } from './storage';
  import { engine } from './runtime';
  import { localUrl,translationInstructionsLimit } from './core';
  import lock from './model-lock.json';
  import {ocrBytes} from './ocr-models';
  import { googleWebOrigin } from './google-web';
  import { prepareChromeTranslator,disposeChromeTranslator,chromeTranslatorAvailability } from './chrome-translator';
  import {extensionCall,detached} from './extension-context';
  import {buildId} from './build-info';
  import {geminiOrigin} from './gemini-web';
  import {geminiProtocolPassed} from './gemini-validation';
  import {allWebOrigins,requestAllWebAccess,specificSites,isSpecificSite} from './site-access';
  let config = $state<Settings>({ ...defaults }), message = $state(''), busy = $state(false), origin = $state(''), error = $state('');
  const version=chrome.runtime.getManifest().version;
  let saved=$state(''),geminiPermission=$state(false);
  const dirty=$derived(!!saved&&saved!==JSON.stringify(config));
  let gpu = $state<any>(),siteGrants=$state<string[]>([]),allSitesGranted=$state(false);
  const mangaGrant=(p:string)=>/^https?:\/\//.test(p)&&!p.includes('googleapis.com')&&!p.includes('gemini.google.com')&&!p.includes('huggingface.co')&&!p.includes('.hf.co')&&!p.includes('127.0.0.1')&&!p.includes('localhost');
  async function readGrants(){siteGrants=specificSites([...((await chrome.permissions.getAll()).origins??[]),...(config.autoSites??[]),...siteGrants]).filter(mangaGrant);allSitesGranted=await chrome.permissions.contains({origins:allWebOrigins});}
  async function grantAll(){try{if(await requestAllWebAccess()){await readGrants();message='所有網站與圖片 CDN 已授權；可直接啟用本頁墨譯或繼續翻譯。';error='';}else message='網站存取未核准。';}catch(e){error=String(e);}}
  function selectSite(site:string,on:boolean){config.autoSites=on?[...new Set([...(config.autoSites??[]),site])]:(config.autoSites??[]).filter(s=>s!==site);}
  let nativeState=$state('尚未檢查');
  let lastGeminiJob=$state<any>(),geminiState=$state<any>(),geminiRunning=$state(false),geminiProgress=$state('');
  async function readGemini(){
    const stored=await chrome.storage.local.get(['geminiValidation','geminiJobs','geminiValidationProgress']);
    geminiState=geminiProtocolPassed(stored.geminiValidation,stored.geminiValidationProgress)?{status:'passed',completed:30}:stored.geminiValidation;
    lastGeminiJob=(stored.geminiJobs as any[]|undefined)?.find(j=>j.kind==='chapter-refinement'||j.kind==='chapter-translation');
    geminiPermission=await chrome.permissions.contains({origins:[geminiOrigin]});
  }
  const showDiagnostics=location.hash==='#gemini-diagnostics';
  onMount(()=>{
    const refresh=()=>detached(readGemini,e=>{error=String(e);});
    refresh();
    const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{
      if(area!=='local')return;
      if(changes.geminiValidationProgress?.newValue){
        const progress=changes.geminiValidationProgress.newValue as {completed:number;phase?:string};
        geminiProgress=`${progress.completed}/30 批 · ${progress.phase??'核對文字框'}`;
      }
      if(changes.geminiValidation||changes.geminiJobs||changes.geminiValidationProgress)refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    chrome.permissions.onAdded.addListener(refresh);chrome.permissions.onRemoved.addListener(refresh);
    if(['#gemini','#gemini-diagnostics'].includes(location.hash))void tick().then(()=>{
      const target=document.getElementById(location.hash.slice(1));
      target?.scrollIntoView({block:'start'});target?.focus({preventScroll:true});
    });
    return()=>{chrome.storage.onChanged.removeListener(changed);chrome.permissions.onAdded.removeListener(refresh);chrome.permissions.onRemoved.removeListener(refresh);};
  });
  async function unlockGemini(){if(!confirm('先前匿名請求的結果可能已產生。解除鎖定後，再次翻譯會建立新請求；確定繼續？'))return;try{const r=await chrome.runtime.sendMessage({channel:'gemini-unlock'});if(!r?.ok)throw new Error(r?.error);message='已人工解除結果未知鎖定。';}catch(e){error=String(e);}}
  async function prepareRefinement(){if(geminiState?.status!=='passed'){await validateGemini();return;}try{if(!await chrome.permissions.request({origins:[geminiOrigin]}))throw new Error('Gemini 網站權限未核准');geminiPermission=true;message='整章 Gemini 已就緒，可回漫畫頁繼續。';error='';}catch(e){error=String(e);}}
  async function validateGemini(){if(busy)return;busy=true;geminiRunning=true;geminiState=undefined;geminiProgress='準備權限與匿名初始化';error='';try{if(!await chrome.permissions.request({origins:[geminiOrigin]}))throw new Error('Gemini 網站權限未核准');message='開始匿名短句與 30 批格式驗證；遇到阻擋立即停止。';const response=await extensionCall(()=>chrome.runtime.sendMessage({channel:'gemini-validate'}));if(!response?.ok)throw new Error(response?.error??'匿名驗證未回應');geminiState=response.result;message=geminiState.status==='passed'?'匿名協定通過 30 批；可選用實驗來源，翻譯品質仍需人工覆核。':`匿名路線受阻：${geminiState.error}（完成 ${geminiState.completed}/30 批）`;}catch(e){error=String(e);}finally{busy=false;geminiRunning=false;}}
  onMount(() => { detached(async()=>{config=await settings();saved=JSON.stringify(config);await readGrants();},e=>{error=String(e);});addEventListener('pagehide',disposeChromeTranslator);return ()=>{removeEventListener('pagehide',disposeChromeTranslator);disposeChromeTranslator();}; });
  async function probeGpu(){if(busy)return;busy=true;error='';try{gpu=await engine({op:'probe',refresh:true});message=gpu.available?'WebGPU 可用':gpu.reason;}catch(e){error=String(e);}finally{busy=false;}}
  const nativeLabels={unavailable:'未支援',downloadable:'待下載',downloading:'下載中',available:'就緒'};
  async function checkNative(){if(busy)return;busy=true;error='';try{const state=await chromeTranslatorAvailability();nativeState=nativeLabels[state.status]+(state.reason?` · ${state.reason}`:'');const response=await extensionCall(()=>chrome.runtime.sendMessage({channel:'native-status'}));message=response?.ok?`推論文件：${nativeLabels[response.result.status as keyof typeof nativeLabels]}`:response?.error;}catch(e){error=String(e);}finally{busy=false;}}
  async function prepareNative(){if(busy)return;busy=true;error='';try{await prepareChromeTranslator(d=>message=d.message);nativeState='就緒';const response=await extensionCall(()=>chrome.runtime.sendMessage({channel:'native-status'}));message=response?.ok&&response.result.status==='available'?'Chrome 本機翻譯語言包及推論文件已就緒。':'可見設定頁已就緒；推論文件尚未就緒，請檢查狀態或選其他來源。';}catch(e){error=String(e);const state=await chromeTranslatorAvailability();nativeState=nativeLabels[state.status];}finally{disposeChromeTranslator();busy=false;}}
  async function save() {
    if(busy||!dirty)return;
    busy=true;error='';message='';
    const draft=$state.snapshot(config);
    try{
      if(draft.backend==='google-web'&&!await chrome.permissions.request({origins:[googleWebOrigin]}))throw new Error('Google 文字請求權限未核准');
      if((draft.backend==='gemini-web'||draft.chapterMode==='gemini-direct')&&geminiState?.status!=='passed')throw new Error('請先在「整章 Gemini」準備匿名連線');
      localUrl(draft.endpoint);localUrl(draft.ocrEndpoint);
      if(['webllm','google-web'].includes(draft.backend)&&draft.localFallback&&!draft.localModel.trim())throw new Error('啟用備援前，請填入本機模型名稱');
      if(draft.auto&&!draft.autoSites?.length)throw new Error('請勾選要自動啟用的漫畫網站');
      await saveSettings(draft);saved=JSON.stringify(draft);
      message='設定已儲存。新工作台與下次工作會採用；執行緒在模型釋放後更新。';
    }catch(e){error=e instanceof Error?e.message:String(e);}
    finally{busy=false;}
  }
  async function prefetch() {
    if (busy) return; busy = true; error = '';
    try { if(config.backend==='webllm')gpu=await engine({op:'probe'}); const modelId = config.backend === 'webllm' ? `Qwen3.5-${config.model === '2b' ? '2B' : '0.8B'}-q4f${gpu?.f16 ? '16' : '32'}_1-MLC` : ''; await engine({ op: 'prefetch', modelId,profile:config.ocrProfile }, d => message = d.message); message = ['google-web','gemini-web'].includes(config.backend) ? 'OCR 模型下載完成。Google／Gemini 網頁翻譯需連線；離線翻譯請選本機模式。' : config.backend==='chrome' ? 'OCR 模型下載完成；Chrome 翻譯語言包由工作台的翻譯按鈕另行取得。' : '模型下載完成，可執行離線驗證。'; }
    catch (e) { error = String(e); } finally { busy = false; }
  }
  async function grant() {
    try {
      const url=new URL(origin),site=`${url.origin}/*`;
      if(!isSpecificSite(site)||!mangaGrant(site))throw new Error('請輸入單一漫畫網站的 HTTP 或 HTTPS 網址');
      siteGrants=specificSites([...siteGrants,site]);selectSite(site,true);origin='';error='';
      message='已勾選這個網站。儲存設定後生效。';
    }catch(e){error=e instanceof Error?e.message:String(e);}
  }
  function clearCache(){void chrome.tabs.create({url:chrome.runtime.getURL('/cache.html')});}
</script>

<main class="moyu">
  <header>
    <nav aria-label="墨譯功能"><a href="reader.html">本機漫畫工作台</a><a href="cache.html">快取與推論資源</a></nav>
    <h1>模型與閱讀設定</h1>
    <small class="mx-note">墨譯 {version} · 建置 {buildId}</small>
  </header>

  <section>
    <h2>初譯來源</h2>
    <label>翻譯方式
      <select bind:value={config.backend}>
        <option value="google-web">Google 網頁翻譯</option>
        <option value="chrome">Chrome 本機翻譯</option>
        <option value="webllm">WebLLM · 瀏覽器 WebGPU</option>
        <option value="local">本機 OpenAI 相容服務</option>
        {#if config.backend==='gemini-web'}<option value="gemini-web">匿名 Gemini · 舊版設定</option>{/if}
      </select>
    </label>
    {#if config.backend==='google-web'}
      <p class="mx-note">日文文字會傳給 Google，漫畫圖片留在本機。無需帳號或金鑰。網頁介面可能限流。</p>
    {:else if config.backend==='chrome'}
      <p class="mx-note">日文轉繁中語言包由 Chrome 管理。首次使用需下載。狀態 {nativeState}</p>
      <div class="actions"><button disabled={busy} onclick={prepareNative}>準備 Chrome 本機翻譯</button><button disabled={busy} onclick={checkNative}>檢查語言包</button></div>
    {:else if config.backend==='webllm'}
      <label>模型<select bind:value={config.model}><option value="2b">Qwen3.5 2B Q4</option><option value="0.8b">Qwen3.5 0.8B Q4 · 較低資源</option></select></label>
      <button disabled={busy} onclick={probeGpu}>檢查 WebGPU</button>
      {#if gpu}<p class="mx-note">WebGPU {gpu.available?'可用':'不可用'} · {gpu.f16?'支援 f16':'使用 f32 模型'}</p>{/if}
    {/if}
    {#if ['webllm','google-web'].includes(config.backend)}
      <label class="check"><input type="checkbox" bind:checked={config.localFallback}>翻譯失敗時改用已設定的本機服務</label>
    {/if}
    {#if config.backend==='local'||(['webllm','google-web'].includes(config.backend)&&config.localFallback)}
      <label>本機 Base URL <input bind:value={config.endpoint} placeholder="http://127.0.0.1:8080/v1"></label>
      <label>模型名稱 <input bind:value={config.localModel} placeholder="例如 qwen3.5:2b"></label>
      <button onclick={()=>{config.endpoint='http://127.0.0.1:8767/v1';config.localModel='qwen3.5-2b';}}>填入墨譯 CPU 服務設定</button>
      <p class="mx-note">可接 Ollama、llama-server、LM Studio 或墨譯的 CPU 伴隨服務。請先在本機啟動服務。</p>
    {/if}
  </section>

  <section id="gemini" tabindex="-1">
    <div class="title-row"><h2>整章 Gemini</h2><span class="chip">{geminiRunning?'驗證進行中':geminiState?.status==='passed'&&geminiPermission?'已就緒':geminiState?.status==='passed'?'待授權':geminiState?.status==='blocked'?'連線受阻':'待準備'}</span></div>
    <label>整章預設模式
      <select aria-label="整章翻譯模式" bind:value={config.chapterMode}>
        <option value="standard">逐張初譯</option>
        <option value="gemini-direct">整章 OCR → Gemini 直譯</option>
      </select>
    </label>
    <p class="mx-note">改動預設會影響新分頁。漫畫頁可另外選擇當前分頁的模式。</p>
    <label class="check"><input type="checkbox" bind:checked={config.refineAfterChapter}>Google 初譯完成後，自動執行整章 Gemini 校正</label>
    <p class="mx-note">直譯先收齊全章日文。二段校正沿用已保存的 Google 初譯，統一人名、語氣和上下文。兩者都只傳送文字，圖片留在本機。</p>
    <button disabled={busy} onclick={prepareRefinement}>準備整章 Gemini 校正</button>
    {#if geminiRunning}<p role="status">{geminiProgress}</p>{/if}
    {#if geminiState?.error}<p class="mx-alert" role="alert">{geminiState.error}</p>{/if}
    <details id="gemini-diagnostics" open={showDiagnostics} tabindex="-1">
      <summary>Gemini 請求紀錄與協定診斷</summary>
      {#if lastGeminiJob}
        <p>最近整章請求 · {({unknown:'結果未知',failed:'失敗',submitted:'已送出',completed:'完成','manually-released':'已解除鎖定'} as Record<string,string>)[lastGeminiJob.status]??lastGeminiJob.status}
          · {lastGeminiJob.pages??'未記錄'} 張 · {lastGeminiJob.finishedAt?((lastGeminiJob.finishedAt-lastGeminiJob.startedAt)/1000).toFixed(1)+' 秒':'尚無結束時間'}</p>
        {#if lastGeminiJob.error}<p class="mx-note">{lastGeminiJob.error}</p>{/if}
      {:else}<p class="mx-note">目前沒有整章請求紀錄。</p>{/if}
      {#if lastGeminiJob?.diagnostic?.receivedBytes!==undefined}
        <p class="mx-note">串流累計 {(lastGeminiJob.diagnostic.receivedBytes/1048576).toFixed(2)} MiB · {lastGeminiJob.diagnostic.frames??0} 段 · 答案 {lastGeminiJob.diagnostic.answerCharacters??0} 字元。</p>
      {/if}
      <p class="mx-note">整章最多 60 張、800 個文字框和 120 KB 輸入。已提交的請求最多等待 180 秒，格式修正最多一次。30 批驗證使用原創句子測試連線與格式。</p>
      <div class="actions">
        <button disabled={busy} onclick={validateGemini}>重新驗證匿名協定（最多 30 批）</button>
        <button class="danger" disabled={busy} onclick={unlockGemini}>解除結果未知鎖定</button>
      </div>
    </details>
  </section>

  <section>
    <div class="title-row"><h2>網站自動翻譯</h2><span class="chip">{config.auto?'已開啟':'手動啟用'}</span></div>
    <label class="check"><input type="checkbox" bind:checked={config.auto}>自動翻譯所選網站的可見漫畫圖片</label>
    {#each siteGrants as site (site)}
      <label class="check"><input type="checkbox" checked={config.autoSites?.includes(site)??false} onchange={e=>selectSite(site,e.currentTarget.checked)}>{site}</label>
    {:else}<p class="mx-note">尚未加入要自動翻譯的網站。</p>{/each}
    <label>加入漫畫網站 <input type="url" bind:value={origin} placeholder="https://example.com"></label>
    <button onclick={grant}>加入並勾選</button>
    <details>
      <summary>網站與圖片 CDN 存取</summary>
      <p class="mx-note">{allSitesGranted?'所有網站與圖片 CDN 已授權。':'Chrome 已限制部分網站存取。'}</p>
      <button onclick={grantAll}>授權所有網站與圖片 CDN</button>
    </details>
  </section>

  <section>
    <h2>漫畫文字辨識</h2>
    <label>OCR 模式
      <select aria-label="OCR 模式" bind:value={config.ocrProfile}><option value="int8">INT8 輕量（預設）</option><option value="fp32">全精度（另行下載）</option></select>
    </label>
    <p class="mx-note">目前選定的 OCR 模型約 {Math.ceil(ocrBytes(config.ocrProfile)/1048576)} MiB。下載會準備該模式及偵測器。</p>
    <div class="actions"><button disabled={busy} onclick={prefetch}>下載模型供離線使用</button><button disabled={busy} onclick={clearCache}>管理快取</button></div>
    <details>
      <summary>執行後端、執行緒與模型版本</summary>
      <label>瀏覽器 OCR 後端 <select bind:value={config.ocrProvider}><option value="wasm">WASM CPU（預設）</option><option value="auto">WebGPU 優先，失敗時使用 WASM</option></select></label>
      <label class="check"><input type="checkbox" bind:checked={config.localOcr}>使用獨立本機 ONNX OCR 服務</label>
      {#if config.localOcr}<label>OCR Base URL <input bind:value={config.ocrEndpoint}></label>{/if}
      <label>WASM 執行緒
        <select aria-label="WASM 執行緒" bind:value={config.wasmThreads}><option value="auto">自動（依 CPU 使用 1–4 緒）</option><option value={1}>1</option><option value={2}>2</option><option value={4}>4</option></select>
      </label>
      <p class="mx-note">支援跨來源隔離和共享記憶體時可用多緒。模型重新載入後套用，可到快取頁查看實際執行緒。</p>
      <label>同時處理圖片
        <select aria-label="在途圖片" bind:value={config.pageConcurrency}><option value={2}>兩張流水線</option><option value={1}>一張串行 · 較低記憶體</option></select>
      </label>
      <p class="mx-note">Google、Chrome 和 Gemini 可在翻譯上一張時辨識下一張。WebLLM 和本機翻譯服務依序處理。</p>
      <details>
        <summary>固定模型與授權清單</summary>
        <pre>{JSON.stringify({vision:lock.vision.map(m=>({id:m.id,revision:m.revision,license:m.license})),llm:lock.llm.map(m=>({id:m.model_id,revision:m.revision,licenseReview:m.convertedLicenseStatus})),font:lock.font},null,2)}</pre>
      </details>
    </details>
  </section>

  <section>
    <h2>翻譯用語與上下文</h2>
    <p class="mx-note">Gemini、WebLLM 與本機模型會使用以下文字。設定會套用於不同作品。</p>
    <label>作品名稱 <input bind:value={config.title}></label>
    <label>章節 <input bind:value={config.chapter}></label>
    <label>人名／術語表 <textarea rows="3" bind:value={config.glossary} placeholder="葵＝小葵；先輩＝學長"></textarea></label>
    <label>漫畫專屬翻譯指示 <textarea aria-label="漫畫專屬翻譯指示" rows="4" maxlength={translationInstructionsLimit} bind:value={config.translationInstructions} placeholder="長老說話較正式；兄長一律稱為哥哥。"></textarea></label>
    <small class="mx-note">{config.translationInstructions.length} / {translationInstructionsLimit} 字</small>
    <label>前頁摘要 <textarea rows="3" bind:value={config.priorSummary}></textarea></label>
  </section>

  <footer>
    <div class="save-row">
      <div>{#if error}<small class="mx-alert" role="alert">{error}</small>{:else}<small class="mx-note" role="status">{message||(!saved?'正在載入設定…':dirty?'有尚未儲存的變更':'設定已同步')}</small>{/if}</div>
      <button class="primary" disabled={!dirty||busy} onclick={save}>儲存設定</button>
    </div>
  </footer>
</main>

<style>
  :global(body) { margin: 0; background: #eef1e9; }
  :global(html) { scroll-padding-bottom: 105px; }
  main { max-width: 800px; margin: auto; padding: clamp(14px, 4vw, 30px) clamp(14px,4vw,28px) 110px; }
  nav, .actions, .title-row { display: flex; align-items: center; gap: 8px 14px; flex-wrap: wrap; }
  h1 { font-size: 26px; margin: 8px 0 2px; }
  h2 { font-size: 17px; margin: 0; }
  section { padding: 16px; background: var(--mx-paper); border: 1px solid var(--mx-line); border-radius: 12px; margin: 14px 0; }
  p { margin: 7px 0 9px; }
  label { display: block; margin: 12px 0; font-size: 13px; }
  label :where(input:not([type=checkbox]), select, textarea) { display: block; width: 100%; margin-top: 5px; }
  .check { display: flex; gap: 8px; align-items: start; overflow-wrap: anywhere; }
  .check input { margin: .25em 0 0; accent-color: var(--mx-green); }
  details { border-top: 1px solid var(--mx-line); padding-top: 8px; margin: 12px 0 0; }
  pre { overflow: auto; font-size: 12px; }
  .chip { background: #e3eee1; color: var(--mx-green); border-radius: 12px; padding: 2px 9px; font-size: 12px; }
  footer { position: fixed; inset-inline: 0; bottom: 0; z-index: 1; background: var(--mx-paper); border-top: 1px solid var(--mx-line); box-shadow: 0 -6px 18px #1b332909; }
  .save-row { max-width: 800px; margin: auto; padding: 9px clamp(14px, 4vw, 28px); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .save-row small { display: block; overflow-wrap: anywhere; }
  .save-row button { flex-shrink: 0; }
</style>
