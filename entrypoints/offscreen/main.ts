import Worker from '../../src/engine.worker?worker';
import { imageBytes } from '../../src/binary';
import {detached} from '../../src/extension-context';
import {chromeTranslate,chromeTranslatorAvailability,disposeChromeTranslator} from '../../src/chrome-translator';
import {SerialLane} from '../../src/scheduling';
const worker = new Worker();
const pending = new Map<string, (value: unknown) => void>();
const nativeLane=new SerialLane(),nativeAborts=new Map<string,AbortController>();
addEventListener('pagehide',disposeChromeTranslator);
worker.onmessage = ({ data }) => {
  if (data.type === 'progress') { detached(()=>chrome.runtime.sendMessage({ channel: 'progress', id: data.id, diagnostic: data.diagnostic })); return; }
  pending.get(data.id)?.(data); pending.delete(data.id);
};
worker.onerror = error => {
  for (const reply of pending.values()) reply({ ok: false, error: error.message || '推論 Worker 失敗' });
  pending.clear();
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.channel === 'offscreen-cancel') { nativeAborts.get(message.id)?.abort();worker.postMessage({ cancel: message.id }); return; }
  if(message.channel==='offscreen-native'){
    if(message.op==='status'){chromeTranslatorAvailability().then(result=>reply({ok:true,result}),error=>reply({ok:false,error:String(error)}));return true;}
    const controller=new AbortController();nativeAborts.set(message.id,controller);
    nativeLane.run(async()=>{const state=await chromeTranslatorAvailability();if(state.status!=='available')throw new Error(state.status==='unavailable'?`Chrome 日文→繁中無法使用：${state.reason??'語言對或環境不支援'}`:'Chrome 語言包尚未在推論文件就緒；請在模型設定按「準備 Chrome 本機翻譯」後重試');
      if(!Array.isArray(message.regions)||message.regions.length>300)throw new Error('Chrome 翻譯區域格式錯誤');
      const result=await chromeTranslate(message.regions,d=>detached(()=>chrome.runtime.sendMessage({channel:'progress',id:message.id,diagnostic:d})),controller.signal);return {ok:true,result};
    },controller.signal).finally(()=>nativeAborts.delete(message.id)).then(reply,error=>reply({ok:false,error:String(error)}));return true;
  }
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
