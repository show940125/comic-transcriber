<script lang="ts">
  import { onMount } from 'svelte';
  import { defaults, type Settings } from './types';
  import { settings, saveSettings } from './storage';
  import { engine } from './runtime';
  import { localUrl } from './core';
  import lock from './model-lock.json';
  import { googleWebOrigin } from './google-web';
  import { prepareChromeTranslator,disposeChromeTranslator } from './chrome-translator';
  let config = $state<Settings>({ ...defaults }), message = $state(''), busy = $state(false), origin = $state(''), error = $state('');
  let gpu = $state<any>();
  onMount(() => { void settings().then(s => config = s); void engine({ op: 'probe' }).then(s => gpu = s).catch(e => error = String(e));addEventListener('pagehide',disposeChromeTranslator);return ()=>{removeEventListener('pagehide',disposeChromeTranslator);disposeChromeTranslator();}; });
  async function prepareNative(){if(busy)return;busy=true;error='';try{await prepareChromeTranslator(d=>message=d.message);message='Chrome 本機翻譯語言包已就緒。';}catch(e){error=String(e);}finally{busy=false;}}
  async function save() {
    error = ''; try { if (config.backend === 'google-web' && !await chrome.permissions.request({ origins: [googleWebOrigin] })) throw new Error('Google 文字請求權限未核准'); localUrl(config.endpoint); localUrl(config.ocrEndpoint); if(['webllm','google-web'].includes(config.backend)&&config.localFallback&&!config.localModel.trim())throw new Error('啟用備援前，請填入本機模型名稱'); await saveSettings($state.snapshot(config)); message = '設定已儲存。工作台重新開啟後生效。'; if(config.backend!=='webllm')void engine({op:'release-llm'}).catch(()=>{}); } catch (e) { error = String(e); }
  }
  async function prefetch() {
    if (busy) return; busy = true; error = '';
    try { const modelId = config.backend === 'webllm' ? `Qwen3.5-${config.model === '2b' ? '2B' : '0.8B'}-q4f${gpu?.f16 ? '16' : '32'}_1-MLC` : ''; await engine({ op: 'prefetch', modelId }, d => message = d.message); message = config.backend==='google-web' ? 'OCR 模型下載完成。Google 網頁翻譯需連線；離線翻譯請選本機模式。' : config.backend==='chrome' ? 'OCR 模型下載完成；Chrome 翻譯語言包由工作台的翻譯按鈕另行取得。' : '模型下載完成，可執行離線驗證。'; }
    catch (e) { error = String(e); } finally { busy = false; }
  }
  async function grant() {
    try { const url = new URL(origin); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('請輸入 HTTP(S) 網址'); const ok = await chrome.permissions.request({ origins: [`${url.origin}/*`] }); message = ok ? '網站已授權，請重新整理漫畫頁。圖片 CDN 可另外授權。' : '網站授權未核准'; } catch (e) { error = String(e); }
  }
  async function clearCache() {
    if (busy) return;
    for (const name of await caches.keys()) await caches.delete(name);
    const { pageKeys = [] } = await chrome.storage.local.get<{ pageKeys: string[] }>('pageKeys');
    await chrome.storage.local.remove([...pageKeys, 'pageKeys']);
    message = '已清除模型下載及頁面快取。已載入 Worker 的模型需重新載入擴充套件才釋放。';
  }
</script>
<main><a href="reader.html">← 漫畫工作台</a><h1>墨譯 · 模型與閱讀設定</h1><p>日文 → 臺灣繁體中文。瀏覽器模型下載後在本機執行。</p>
  <section><h2>翻譯模型</h2><label>執行方式<select bind:value={config.backend}><option value="google-web">Google 網頁翻譯 · 免金鑰、零 API 費</option><option value="chrome">Chrome Translator API · 本機、零 API 費</option><option value="webllm">瀏覽器 WebGPU · WebLLM</option><option value="local">本機 OpenAI-compatible 服務</option></select></label>
  {#if config.backend === 'google-web'}<p class="hint">OCR 後的日文文字會傳給 Google；漫畫圖片留在本機。不需帳號、金鑰或 Cloud 帳務。此為非官方網頁介面，可能限流或改版；遇到錯誤即停止。人物術語與前頁上下文由本機模型模式提供。</p>{/if}
  {#if config.backend === 'chrome'}<p class="hint">Chrome 的專用翻譯模型在本機執行，不需 Cloud 金鑰或帳務。首次下載語言包；可用性依瀏覽器與語言對確認。可先準備語言包，之後使用一鍵翻譯。</p><button disabled={busy} onclick={prepareNative}>準備 Chrome 本機翻譯</button>{/if}
  {#if config.backend === 'webllm'}<label>模型<select bind:value={config.model}><option value="2b">Qwen3.5 2B Q4 · 品質候選</option><option value="0.8b">Qwen3.5 0.8B Q4 · 低資源候選</option></select></label><p class="hint">WebGPU：{gpu?.available ? '可用' : '尚未確認／不可用'}；shader-f16：{gpu?.f16 ? '支援' : '使用 f32 候選'}。模型品質尚待真實漫畫人工驗收。</p>{/if}
  {#if ['webllm','google-web'].includes(config.backend)}<label class="check"><input type="checkbox" bind:checked={config.localFallback}>翻譯來源失敗時，改用已設定的本機服務</label>{/if}
  {#if config.backend === 'local' || (['webllm','google-web'].includes(config.backend) && config.localFallback)}<label>本機 Base URL<input bind:value={config.endpoint} placeholder="http://127.0.0.1:8080/v1"></label><label>模型名稱<input bind:value={config.localModel} placeholder="例如 qwen3.5:2b"></label><button onclick={()=>{config.endpoint='http://127.0.0.1:8767/v1';config.localModel='qwen3.5-2b';}}>填入本專案 CPU 服務設定</button><p class="hint">可接 Ollama、llama-server、LM Studio，或本專案的 CPU 伴隨服務。僅接受 localhost；先啟動服務再使用。</p>{/if}
  <label>瀏覽器 OCR 後端<select bind:value={config.ocrProvider}><option value="auto">WebGPU 優先，失敗時降級 WASM</option><option value="wasm">固定使用 WASM CPU（內顯可比較速度）</option></select></label><label class="check"><input type="checkbox" bind:checked={config.localOcr}>使用獨立本機 ONNX OCR 服務</label>{#if config.localOcr}<label>OCR Base URL<input bind:value={config.ocrEndpoint}></label>{/if}</section>
  <section><h2>故事上下文</h2><p class="hint">人名、術語與前頁摘要用於 Qwen／本機服務。Google 網頁與 Chrome 本機翻譯採逐框翻譯；譯文可在工作台直接校正。</p><label>作品名稱<input bind:value={config.title}></label><label>章節<input bind:value={config.chapter}></label><label>人名／術語表<textarea rows="4" bind:value={config.glossary} placeholder="例：葵＝小葵；先輩＝學長"></textarea></label><label>前頁摘要<textarea rows="3" bind:value={config.priorSummary}></textarea></label><label class="check"><input type="checkbox" bind:checked={config.auto}>在已授權網站自動翻譯可見漫畫圖片（串行並預讀下一頁）</label></section>
  <section><h2>網站權限</h2><label>漫畫網站或圖片 CDN 網址<input bind:value={origin} placeholder="https://example.com"></label><button onclick={grant}>授權這個來源</button><p class="hint">只授權你需要的網站；授權後重新整理頁面。</p></section>
  <div class="actions"><button class="primary" onclick={save}>儲存設定</button><button disabled={busy} onclick={prefetch}>下載模型供離線使用</button><button disabled={busy} onclick={clearCache}>清除快取</button></div>
  {#if message}<p role="status">{message}</p>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}
  <details><summary>固定模型與授權清單</summary><pre>{JSON.stringify({ vision: lock.vision.map(m => ({ id: m.id, revision: m.revision, license: m.license })), llm: lock.llm.map(m => ({ id: m.model_id, revision: m.revision, licenseReview: m.convertedLicenseStatus })), font: lock.font }, null, 2)}</pre></details>
</main>
<style>:global(body){margin:0;background:#f1eee6;font:14px "Microsoft JhengHei",sans-serif;color:#293f32}main{max-width:800px;margin:auto;padding:36px}a{color:#355947}h1{font-size:27px}h2{font-size:18px}section{padding:22px;background:#fafbf7;border:1px solid #d3dbce;border-radius:10px;margin:18px 0}label{display:block;margin:15px 0;font-size:13px}input,select,textarea{box-sizing:border-box;width:100%;display:block;padding:10px;margin-top:7px;border:1px solid #cbd6c8;border-radius:5px;font:inherit;background:white;color:#293f32}.check{display:flex;align-items:center;gap:9px}.check input{width:17px;height:17px;margin:0}button{padding:10px 14px;border:1px solid #b9c7b9;background:#f9fbf5;border-radius:6px;font:inherit;cursor:pointer}.primary{background:#284e3c;color:white}button:disabled{opacity:.5}.hint{font-size:12px;color:#657a69;line-height:1.7}.actions{display:flex;gap:10px;flex-wrap:wrap}.error{color:#9b3823}pre{overflow:auto;font-size:11px}details{margin-top:28px}</style>
