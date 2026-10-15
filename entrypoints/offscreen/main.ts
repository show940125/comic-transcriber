import Worker from '../../src/engine.worker?worker';
import { imageBytes } from '../../src/binary';
import {detached} from '../../src/extension-context';
import {chromeTranslate,chromeTranslatorAvailability,disposeChromeTranslator,chromeTranslatorState} from '../../src/chrome-translator';
import {SerialLane} from '../../src/scheduling';
import {IdleRuntime} from '../../src/idle-runtime';
import {geminiTranslate,anonymousGemini} from '../../src/gemini-web';
import {refineChapter} from '../../src/chapter-refinement';
import {defaults,type Region} from '../../src/types';
let worker:Worker|undefined;
let lastWorkerState:Record<string,unknown>={models:0};
let globallyBusy=0;
const idle=new IdleRuntime(()=>detached(()=>chrome.runtime.sendMessage({channel:'runtime-idle-expired'})));
idle.activity(0);
// Offscreen messages keep the MV3 lease owner alive during quiet network calls.
const heartbeat=setInterval(()=>{if(globallyBusy)detached(()=>chrome.runtime.sendMessage({channel:'runtime-heartbeat'}));},20_000);
const pending = new Map<string, (value: unknown) => void>();
const workerRequests=new Map<string,any>();
const nativeLane=new SerialLane(),nativeAborts=new Map<string,AbortController>();
const geminiLane=new SerialLane(),geminiAborts=new Map<string,AbortController>();
let geminiStopped=false;
addEventListener('pagehide',disposeChromeTranslator);
function getWorker(){if(worker)return worker;lastWorkerState={models:0};const created=worker=new Worker();
created.onmessage = ({ data }) => {
  if(data.type==='runtime-snapshot'){lastWorkerState=data.result;return;}
  if(data.type==='cache-record'){detached(()=>chrome.runtime.sendMessage({channel:'cache-model-record',record:data.record}));return;}
  if(data.type==='models-ready'){detached(()=>chrome.runtime.sendMessage({channel:'cache-model-scan'}));return;}
  if (data.type === 'progress') { detached(()=>chrome.runtime.sendMessage({ channel: 'progress', id: data.id, diagnostic: data.diagnostic })); return; }
  if(data.retrySingleThread&&workerRequests.get(data.id)?.runtimeOptions?.wasmThreads!==1){created.terminate();worker=undefined;const replacement=getWorker();for(const request of workerRequests.values()){request.runtimeOptions={wasmThreads:1,fallbackReason:`多執行緒建立失敗，使用單執行緒：${data.error}`};replacement.postMessage(request);}return;}
  workerRequests.delete(data.id);pending.get(data.id)?.(data); pending.delete(data.id);
};
created.onerror = error => {
  for (const reply of pending.values()) reply({ ok: false, error: error.message || '推論 Worker 失敗' });
  pending.clear();
  workerRequests.clear();created.terminate();worker=undefined;
};return created;}
const release=()=>{clearInterval(heartbeat);idle.dispose();worker?.terminate();worker=undefined;disposeChromeTranslator();};
addEventListener('pagehide',release);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if(message.channel==='offscreen-ready'){reply({ok:true,ready:true});return;}
  if(message.channel==='offscreen-busy'){globallyBusy=message.count;idle.activity(globallyBusy);reply({ok:true});return;}
  if(message.channel==='offscreen-release'){release();reply({ok:true});return;}
  if(message.channel==='offscreen-runtime-status'){
    const translator=chromeTranslatorState();reply({ok:true,result:{phase:globallyBusy?(worker&&!lastWorkerState.models?'loading':'running'):'waiting',worker:!!worker,...(worker?lastWorkerState:{models:0}),...translator}});return;
  }
  if (message.channel === 'offscreen-cancel') { nativeAborts.get(message.id)?.abort();geminiAborts.get(message.id)?.abort();worker?.postMessage({ cancel: message.id }); return; }
  if(message.channel==='offscreen-gemini'){
    const controller=new AbortController();geminiAborts.set(message.id,controller);
    const record=async(job:any)=>{const response=await chrome.runtime.sendMessage({channel:'gemini-record',job});if(!response?.ok)throw new Error(response?.error??'匿名請求狀態保存失敗');};
    geminiLane.run(async()=>{
      if(message.op==='validate'){
        geminiStopped=false;
        let completed=0;const cases=['こんにちは。','お兄ちゃん、待って！','私は葵です。','もう大丈夫だよ。','それ、本当なの？'];
        try{for(let i=0;i<30;i++){
          const regions:Region[]=[0,1].map(n=>({id:`probe-${i}-${n}`,order:n,x:0,y:0,width:50,height:50,source:cases[(i+n)%cases.length],translation:'',score:1,warnings:[],kind:'bubble',render:'auto'}));
          const result=await geminiTranslate(regions,defaults,`poc-${i}`,controller.signal,record,(prompt,signal)=>anonymousGemini(prompt,signal,fetch,phase=>detached(()=>chrome.runtime.sendMessage({channel:'gemini-validation-progress',completed,total:30,phase}))));completed++;
          await chrome.runtime.sendMessage({channel:'gemini-validation-progress',completed,total:30,sample:result.map(r=>({id:r.id,source:r.source,translation:r.translation}))});
        }return {ok:true,result:{status:'passed',completed,required:30,model:'網站自動選擇',quality:'待人工覆核',at:Date.now()}};
        }catch(error){geminiStopped=true;return {ok:true,result:{status:'blocked',completed,required:30,error:String(error),at:Date.now()}};}
      }
      if(geminiStopped)throw new Error('匿名 Gemini 前一批失敗，待重新驗證後才能恢復');
      if(message.op==='refine'){
        if(!Array.isArray(message.pages)||message.pages.length>60)throw new Error('整章校正頁面格式錯誤');
        const started=performance.now(),progress=(text:string)=>detached(()=>chrome.runtime.sendMessage({channel:'progress',id:message.id,diagnostic:{stage:'translating',message:text,backend:'gemini-web/refinement',model:'網站自動選擇'}}));
        progress(`整章 ${message.pages.length} 張：送出全部原文與初譯進行二段校正`);
        try{const result=await refineChapter(message.pages,message.settings,controller.signal,record,(prompt,signal)=>anonymousGemini(prompt,signal,fetch,progress));progress(`完整回覆已核對 ${result.regions} 個區域，準備逐張重排`);return {ok:true,result:{...result,ms:performance.now()-started}};}catch(error){if(!controller.signal.aborted)geminiStopped=true;throw error;}
      }
      if(!Array.isArray(message.regions)||message.regions.length>300)throw new Error('Gemini 區域格式錯誤');
      const started=performance.now(),progress=(text:string)=>detached(()=>chrome.runtime.sendMessage({channel:'progress',id:message.id,diagnostic:{stage:'translating',message:text,backend:'gemini-web/anonymous',model:'網站自動選擇'}}));progress('匿名 Gemini：依閱讀順序翻譯');
      try{const result=await geminiTranslate(message.regions,message.settings,message.pageHash,controller.signal,record,(prompt,signal)=>anonymousGemini(prompt,signal,fetch,progress));detached(()=>chrome.runtime.sendMessage({channel:'progress',id:message.id,diagnostic:{stage:'complete',message:'匿名 Gemini 翻譯與區域 ID 核對完成',backend:'gemini-web/anonymous',model:'網站自動選擇',ms:performance.now()-started}}));return {ok:true,result};}catch(error){if(!controller.signal.aborted)geminiStopped=true;throw error;}
    },controller.signal).finally(()=>geminiAborts.delete(message.id)).then(reply,error=>{if(!controller.signal.aborted)geminiStopped=true;reply({ok:false,error:String(error),state:error?.state,httpStatus:error?.httpStatus,partial:error?.partial});});return true;
  }
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
  const work={ id: message.id, request,runtimeOptions:message.runtimeOptions, base: chrome.runtime.getURL('/') };workerRequests.set(message.id,work);getWorker().postMessage(work);
  return true;
});
