import * as ort from 'onnxruntime-web/webgpu';
import { CreateMLCEngine, type MLCEngine } from '@mlc-ai/web-llm';
import lock from './model-lock.json';
import { detectorBox, localUrl, parseTranslations, prompt, readingOrder, iou } from './core';
import type { Diagnostic, EngineRequest, Region, Settings } from './types';
import { bubbleRegions } from './detection';
import { traditional } from './language';
import { needsOcrReview, ocrReviewWarning } from './ocr-quality';
import { imageBase64 } from './binary';
import { createGpuProbe } from './gpu';
let base = '', current = '';
let tail: Promise<unknown> = Promise.resolve();
const aborts = new Map<string, AbortController>();
const sessions = new Map<string, { session: ort.InferenceSession; backend: string; bytes: ArrayBuffer }>();
let llm: MLCEngine | undefined, loadedId = '', vocab: string[] = [];
const report = (d: Diagnostic) => postMessage({ type: 'progress', id: current, diagnostic: d });
function check(signal: AbortSignal) { signal.throwIfAborted(); }
const capability = createGpuProbe(() => navigator.gpu);
async function artifact(model: string, name: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const spec = lock.vision.find(m => m.id === model)!.files.find(f => f.name === name)!;
  const cache = await caches.open('comic-vision-v1');
  let response = await cache.match(spec.url);
  if (!response) {
    report({ stage: 'loading', message: `下載 ${name}（${Math.round(spec.bytes / 1048576)} MB）`, model });
    // Optional offline distribution can carry weights inside the extension.
    const local = await fetch(`${base}models/${model}/${name}`, { signal }).catch(() => null);
    response = local?.ok ? local : await fetch(spec.url, { signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`模型下載失敗：${name} (${response.status})`);
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
    if (spec.sha256 && hash !== spec.sha256) throw new Error(`模型雜湊錯誤：${name}`);
    await cache.put(spec.url, new Response(bytes)); return bytes;
  }
  const bytes = await response.arrayBuffer();
  if (spec.sha256) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    if ([...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('') !== spec.sha256) { await cache.delete(spec.url); throw new Error(`快取模型雜湊錯誤：${name}，請重新下載`); }
  }
  return bytes;
}
async function session(model: string, name: string, signal: AbortSignal, wasmOnly = false) {
  const key = `${model}/${name}/${wasmOnly ? 'wasm' : 'auto'}`;
  if (sessions.has(key)) return sessions.get(key)!;
  const bytes = await artifact(model, name, signal); check(signal);
  ort.env.wasm.wasmPaths = `${base}ort/`;
  // Single-thread is a tested baseline when extension isolation cannot enable threads.
  ort.env.wasm.numThreads = 1;
  let backend = model === 'detector' || wasmOnly ? 'wasm' : (await capability()).available ? 'webgpu+wasm' : 'wasm';
  let instance: ort.InferenceSession;
  try { instance = await ort.InferenceSession.create(bytes, { executionProviders: backend === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'] }); }
  catch (error) {
    if (backend === 'wasm') throw error;
    report({ stage: 'loading', message: '此模型 GPU 建立失敗，改用 WASM', model: name, backend: 'wasm' });
    backend = 'wasm'; instance = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  }
  const value = { session: instance, backend, bytes }; sessions.set(key, value); return value;
}
async function run(value: Awaited<ReturnType<typeof session>>, feeds: Record<string, ort.Tensor>, signal: AbortSignal) {
  check(signal);
  try { return await value.session.run(feeds); }
  catch (error) {
    if (value.backend === 'wasm') throw error;
    await value.session.release(); value.backend = 'wasm';
    value.session = await ort.InferenceSession.create(value.bytes, { executionProviders: ['wasm'] });
    report({ stage: 'loading', message: 'GPU 執行失敗，已降級 WASM', backend: 'wasm' });
    return await value.session.run(feeds);
  }
}
function pixels(bitmap: ImageBitmap, side: number, region?: Region, gray = false) {
  const canvas = new OffscreenCanvas(side, side), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  if (region) ctx.drawImage(bitmap, region.x, region.y, region.width, region.height, 0, 0, side, side);
  else ctx.drawImage(bitmap, 0, 0, side, side);
  const data = ctx.getImageData(0, 0, side, side).data, plane = side * side, values = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    if (gray) { const v = ((data[i * 4] * .299 + data[i * 4 + 1] * .587 + data[i * 4 + 2] * .114) / 255 - .5) * 2; for (let c = 0; c < 3; c++) values[c * plane + i] = v; }
    else for (let c = 0; c < 3; c++) values[c * plane + i] = data[i * 4 + c] / 255;
  }
  return { tensor: new ort.Tensor('float32', values, [1, 3, side, side]), data };
}
async function detect(request: Extract<EngineRequest, { op: 'detect' }>, signal: AbortSignal): Promise<Region[]> {
  const bitmap = await createImageBitmap(request.image), started = performance.now();
  try {
    const s = await session('detector', 'detector-v4-s_int8.onnx', signal);
    // This pinned export scales XYXY with [width,height], verified on a non-square page.
    const input = pixels(bitmap, 640), feeds = { images: input.tensor, orig_target_sizes: new ort.Tensor('int64', BigInt64Array.from([BigInt(bitmap.width), BigInt(bitmap.height)]), [1, 2]) };
    report({ stage: 'detecting', message: '偵測文字與氣泡', backend: s.backend, model: 'RT-DETR INT8' });
    const out = await run(s, feeds, signal); check(signal);
    const labels = out.labels.data, boxes = out.boxes.data, scores = out.scores.data;
    const regions: Region[] = [], bubbles: Region[] = [];
    for (let i = 0; i < scores.length; i++) {
      const label = Number(labels[i]), score = Number(scores[i]);
      if (score < (label === 0 ? .6 : .45)) continue;
      const geometry=detectorBox(Array.from({length:4},(_,j)=>Number(boxes[i*4+j])),bitmap.width,bitmap.height);if(!geometry)continue;
      const r:Region = { id: crypto.randomUUID(), ...geometry, order: 0, source: '', translation: '', score, warnings: score < .65 ? ['偵測信心偏低，請檢查文字框'] : [], kind: label === 2 ? 'free' : 'bubble', render: label === 2 ? 'overlay' : 'auto' };
      if (r.width > 4 && r.height > 4) (label === 0 ? bubbles : regions).push(r);
    }
    input.tensor.dispose(); feeds.orig_target_sizes.dispose(); Object.values(out).forEach(t => t.dispose());
    const refined = bubbleRegions(bitmap, bubbles), candidates = [...refined, ...regions.filter(r => !bubbles.some(b => r.x + r.width/2 > b.x && r.x + r.width/2 < b.x + b.width && r.y + r.height/2 > b.y && r.y + r.height/2 < b.y + b.height))];
    const kept: Region[] = [];
    for (const r of candidates.sort((a, b) => b.score - a.score)) if (!kept.some(k => iou(k, r) > .6)) kept.push(r);
    report({ stage: 'review', message: `找到 ${kept.length} 個文字區域，請確認框選`, backend: s.backend, model: 'RT-DETR INT8', ms: performance.now() - started });
    return readingOrder(kept);
  } finally { bitmap.close(); }
}
async function recognize(request: Extract<EngineRequest, { op: 'ocr' }>, signal: AbortSignal): Promise<Region[]> {
  const bitmap = await createImageBitmap(request.image), started = performance.now();
  try {
    const encoder = await session('manga-ocr', 'encoder_model.onnx', signal, request.provider === 'wasm'), decoder = await session('manga-ocr', 'decoder_model.onnx', signal, request.provider === 'wasm');
    if (!vocab.length) vocab = new TextDecoder().decode(await artifact('manga-ocr', 'vocab.txt', signal)).trimEnd().split(/\r?\n/);
    const result: Region[] = [];
    for (const region of [...request.regions].sort((a, b) => a.order - b.order)) {
      check(signal); report({ stage: 'ocr', message: `辨識 ${result.length + 1}/${request.regions.length}`, backend: `${encoder.backend}/${decoder.backend}`, model: 'Manga-OCR' });
      const crop = pixels(bitmap, 224, region.ocrBox ? { ...region, ...region.ocrBox } : region, true);
      let dark = 0, light = 0;
      for (let i = 0; i < crop.data.length; i += 4) { const v = crop.data[i] * .299 + crop.data[i + 1] * .587 + crop.data[i + 2] * .114; if (v < 100) dark++; if (v > 155) light++; }
      if (dark < 24 || light < 24) { crop.tensor.dispose(); result.push({ ...region, source: '', translation: '', ocrDone:true, warnings: [...region.warnings, '疑似無文字，已略過；可手動填入原文'] }); continue; }
      const encoded = await run(encoder, { [encoder.session.inputNames[0]]: crop.tensor }, signal);
      const hidden = encoded[encoder.session.outputNames[0]], tokens = [2];
      for (let t = 0; t < 64; t++) {
        check(signal);
        const ids = new ort.Tensor('int64', BigInt64Array.from(tokens.map(BigInt)), [1, tokens.length]);
        const feeds: Record<string, ort.Tensor> = {};
        for (const name of decoder.session.inputNames) feeds[name] = /encoder|hidden/i.test(name) ? hidden : ids;
        const output = await run(decoder, feeds, signal), logits = output[decoder.session.outputNames[0]];
        const size = logits.dims.at(-1)!, start = logits.data.length - size;
        let index = 0, maximum = -Infinity;
        for (let i = 0; i < size; i++) if (Number(logits.data[start + i]) > maximum) { maximum = Number(logits.data[start + i]); index = i; }
        ids.dispose(); Object.values(output).forEach(tensor => tensor.dispose());
        if (index === 3) break; tokens.push(index);
      }
      const text = tokens.slice(1).filter(t => t >= 5).map(t => vocab[t] ?? '').join('').replace(/##|\[UNK\]/g, '').replace(/\s+/g, '');
      const warnings = [...region.warnings];
      if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) warnings.push('辨識結果缺少日文字元，請覆核');
      if (tokens.length >= 64) warnings.push('辨識長度到達上限，請拆分文字框');
      const needsReview=needsOcrReview(text);if(needsReview)warnings.push(ocrReviewWarning);
      result.push({ ...region, source: text, translation:'', needsReview, ocrDone:true, warnings });
      crop.tensor.dispose(); Object.values(encoded).forEach(t => t.dispose());
    }
    report({ stage: 'ocr', message: 'OCR 完成；請覆核原文', backend: `${encoder.backend}/${decoder.backend}`, model: 'Manga-OCR', ms: performance.now() - started });
    return result;
  } finally { bitmap.close(); }
}
async function loadLlm(modelId: string, signal: AbortSignal) {
  if (llm && loadedId === modelId) return llm;
  if (!(await capability()).available) throw new Error('WebGPU 無法使用。可在設定改用本機服務，OCR 仍可使用 WASM。');
  if (llm) { await llm.unload(); llm = undefined; loadedId = ''; }
  // Release vision tensors before allocating the language model on shared-memory GPUs.
  for (const value of sessions.values()) await value.session.release(); sessions.clear();
  const config = lock.llm.find(m => m.model_id === modelId);
  if (!config) throw new Error('模型不在固定清單');
  check(signal);
  llm = await CreateMLCEngine(modelId, {
    appConfig: { model_list: [{ ...config, model_lib: base + config.model_lib.slice(1) }] },
    initProgressCallback: p => report({ stage: 'loading', message: p.text, backend: 'webgpu', model: modelId }),
  });
  loadedId = modelId; check(signal); return llm;
}
async function translate(request: Extract<EngineRequest, { op: 'translate' }>, signal: AbortSignal) {
  const regions = request.regions.filter(r => r.source.trim()&&!r.needsReview&&!needsOcrReview(r.source)).sort((a, b) => a.order - b.order);
  const result = structuredClone(request.regions); let preceding = '', started = performance.now();
  if(!regions.length){report({stage:'review',message:'原文需要核對後才能翻譯'});return result;}
  let model: MLCEngine | undefined;
  let usedBackend = 'local-http';
  async function localBatch(messages: ReturnType<typeof prompt>) {
    const endpoint = localUrl(request.settings.endpoint);
    if (!request.settings.localModel.trim()) throw new Error('請設定本機翻譯模型名稱');
    const res = await fetch(`${endpoint}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: request.settings.localModel, messages, temperature: 0, max_tokens: 1000, stream: false }), signal });
    if (!res.ok) throw new Error(`本機翻譯端點回覆 ${res.status}`);
    const out = await res.json(); usedBackend = typeof out.backend === 'string' ? `local-http/${out.backend}` : 'local-http';
    return out.choices?.[0]?.message?.content ?? '';
  }
  async function fallback(reason: string) {
    if (!request.settings.localFallback) throw new Error(reason);
    check(signal); report({ stage:'translating',message:'瀏覽器模型失敗，改用已啟用的本機備援',backend:'local-http',model:request.settings.localModel });
    if (model) await model.unload().catch(()=>{}); model=undefined;llm=undefined;loadedId='';
  }
  if (request.settings.backend === 'webllm') {
    try { model = await loadLlm(request.modelId, signal); usedBackend='webgpu'; }
    catch(error) { await fallback(error instanceof Error?error.message:String(error)); }
  }
  for (let i = 0; i < regions.length; i += 6) {
    check(signal); const group = regions.slice(i, i + 6);
    report({ stage: 'translating', message: `翻譯 ${i + 1}–${i + group.length}/${regions.length}`, backend: usedBackend, model: model?request.modelId:request.settings.localModel });
    const messages = prompt(group, request.settings, preceding); let raw = '';
    if (model) {
      try {
        await model.resetChat();
        const out = await model.chat.completions.create({ messages, temperature: 0, max_tokens: 1000, extra_body: { enable_thinking: false } });
        raw = out.choices[0]?.message.content ?? '';
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/GPU|device|deleted object|disposed|GrammarMatcher/i.test(detail)) {
          llm = undefined; loadedId = ''; await model.unload().catch(() => {});
          if(!request.settings.localFallback)throw new Error(`GPU 模型工作階段失效，已釋放模型。可在設定改用本機服務。詳細：${detail}`);
        }
        await fallback(detail);raw=await localBatch(messages);
      }
    } else {
      raw=await localBatch(messages);
    }
    check(signal); let texts: Map<string,string>;
    try { texts=parseTranslations(raw,group); }
    catch(error) { if(!model||!request.settings.localFallback)throw error;await fallback(String(error));raw=await localBatch(messages);texts=parseTranslations(raw,group); }
    for (const r of result) if (texts.has(r.id)) r.translation = traditional(texts.get(r.id)!);
    preceding += group.map(r => `${r.source} → ${texts.get(r.id)}`).join('\n') + '\n';
  }
  report({ stage: 'complete', message: '翻譯完成', backend: usedBackend, model: model?request.modelId:request.settings.localModel, ms: performance.now() - started });
  return result;
}
async function handle(request: EngineRequest, signal: AbortSignal) {
  switch (request.op) {
    case 'probe': return capability(request.refresh);
    case 'release-llm':
      if(llm)await llm.unload().catch(()=>{});llm=undefined;loadedId='';return {released:true};
    case 'detect': return detect(request, signal);
    case 'ocr': return recognize(request, signal);
    case 'local-ocr': {
      const endpoint=localUrl(request.endpoint),image=imageBase64(new Uint8Array(await request.image.arrayBuffer()));
      const response=await fetch(`${endpoint}/ocr`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,regions:request.regions}),signal});
      if(!response.ok)throw new Error(`本機 OCR 回覆 ${response.status}`);return response.json();
    }
    case 'translate': return translate(request, signal);
    case 'prefetch':
      for (const model of lock.vision) for (const file of model.files) await artifact(model.id, file.name, signal);
      if (request.modelId) await loadLlm(request.modelId, signal);
      return true;
  }
}
onmessage = ({ data }) => {
  if (data.cancel) { aborts.get(data.cancel)?.abort(); if (current === data.cancel) llm?.interruptGenerate(); return; }
  const controller = new AbortController(); aborts.set(data.id, controller);
  const operation = async () => {
    base = data.base; current = data.id;
    try { const result = await handle(data.request, controller.signal); postMessage({ id: data.id, ok: true, result }); }
    catch (error) { postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error), modelOutput: (error as { modelOutput?: string })?.modelOutput }); }
    finally { aborts.delete(data.id); current = ''; }
  };
  tail = tail.catch(() => {}).then(operation);
};
