import Worker from '../../src/engine.worker?worker';
import { imageBytes } from '../../src/binary';
const worker = new Worker();
const pending = new Map<string, (value: unknown) => void>();
worker.onmessage = ({ data }) => {
  if (data.type === 'progress') { void chrome.runtime.sendMessage({ channel: 'progress', id: data.id, diagnostic: data.diagnostic }); return; }
  pending.get(data.id)?.(data); pending.delete(data.id);
};
worker.onerror = error => {
  for (const reply of pending.values()) reply({ ok: false, error: error.message || '推論 Worker 失敗' });
  pending.clear();
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.channel === 'offscreen-cancel') { worker.postMessage({ cancel: message.id }); return; }
  if (message.channel !== 'offscreen') return;
  const request = message.request;
  try {
    if (typeof request.image === 'string') request.image = new Blob([imageBytes(request.image)], { type: request.mime });
    else if (Array.isArray(request.image)) request.image = new Blob([new Uint8Array(request.image)], { type: request.mime });
  } catch { reply({ok:false,error:'圖片訊息格式或大小錯誤'});return; }
  pending.set(message.id, reply);
  worker.postMessage({ id: message.id, request, base: chrome.runtime.getURL('/') });
  return true;
});
