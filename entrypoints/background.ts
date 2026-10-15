import { defineBackground } from 'wxt/utils/define-background';
import { publicImageUrl } from '../src/core';
import { imageBase64 } from '../src/binary';
import {cachePageDirect,storageWrite} from '../src/storage';
import {inventory,scanCaches,removeCache,recordKey} from '../src/cache-inventory';
import {importCorrection} from '../src/core';
import {SerialLane,ResourceSlots} from '../src/scheduling';
import type {Settings} from '../src/types';
import {geminiOrigin} from '../src/gemini-web';
import {geminiProtocolPassed} from '../src/gemini-validation';
import {waitForOffscreenReady} from '../src/offscreen-ready';
import {specificSites} from '../src/site-access';
export default defineBackground(() => {
  let creating: Promise<void> | undefined;
  let closing:Promise<void>|undefined,maintenance=false,releaseRequested=false,geminiValidationRunning=false;
  const leases=new Set<string>();
  const pageLeaseOwners=new Map<string,number>();
  async function syncBusy(){if(creating)await creating;if(await chrome.offscreen.hasDocument())await chrome.runtime.sendMessage({channel:'offscreen-busy',count:leases.size});if(!leases.size&&releaseRequested&&!closing)await releaseRuntime();}
  function lease(id:string){leases.add(id);void syncBusy().catch(()=>{});return ()=>{leases.delete(id);void syncBusy().catch(()=>{});};}
  async function releaseRuntime(){releaseRequested=true;if(leases.size)return {ok:true,released:false,busy:true};
    closing??=(async()=>{if(creating)await creating;if(await chrome.offscreen.hasDocument()){await chrome.runtime.sendMessage({channel:'offscreen-release'});await chrome.offscreen.closeDocument();}releaseRequested=false;await chrome.storage.session.set({runtimeReleasedAt:Date.now()});})().finally(()=>{closing=undefined;});await closing;return {ok:true,released:true};}
  async function activate(tabId:number){await chrome.scripting.executeScript({target:{tabId},files:['content-scripts/content.js']});}
  async function autoScripts(){const {settings={}}=await chrome.storage.local.get('settings'),conf=settings as Partial<Settings>,sites=specificSites(conf.autoSites);await chrome.scripting.unregisterContentScripts({ids:['comic-auto']}).catch(()=>{});if(conf.auto&&sites.length)await chrome.scripting.registerContentScripts([{id:'comic-auto',matches:sites,js:['content-scripts/content.js'],runAt:'document_idle'}]);}
  const jobs = new Map<string, Promise<unknown>>();
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.settings)void autoScripts().catch(console.warn);});
  const owners = new Map<string,{tabId:number;frameId:number}>();
  const googleLane=new SerialLane(),googleAborts=new Map<string,AbortController>();let lastGoogleStart=0;
  let googleBlocked=0,googleBlockLoaded=false;
  const imageSlots=new ResourceSlots(2);
  chrome.tabs.onRemoved.addListener(tabId=>{imageSlots.releaseOwner(tabId);for(const [id,owner]of pageLeaseOwners)if(owner===tabId){leases.delete('image:'+id);pageLeaseOwners.delete(id);}void syncBusy().catch(()=>{});for(const [id,owner]of owners)if(owner.tabId===tabId)void chrome.runtime.sendMessage({channel:'offscreen-cancel',id}).catch(()=>{});});
  async function offscreen() {
    if(closing)await closing;
    creating ??= (async()=>{
      if(!await chrome.offscreen.hasDocument())await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: '離線漫畫模型的專用推論 Worker' });
      await waitForOffscreenReady(()=>chrome.runtime.sendMessage({channel:'offscreen-ready'}));
      await chrome.runtime.sendMessage({channel:'offscreen-busy',count:leases.size});
    })().finally(() => { creating = undefined; });
    await creating;
  }
  chrome.runtime.onInstalled.addListener(details => {
    void autoScripts().catch(console.warn);
    void chrome.contextMenus.removeAll().then(()=>{chrome.contextMenus.create({ id: 'comic-translate', title: '墨譯：翻譯這張漫畫', contexts: ['image'] },()=>{if(chrome.runtime.lastError)console.warn('墨譯圖片選單',chrome.runtime.lastError.message);});}).catch(error=>console.warn('墨譯圖片選單',error));
    if(details.reason==='update'&&details.previousVersion&&/^0\.1\.[0-8]$/.test(details.previousVersion))void chrome.storage.local.get<{settings?:Partial<Settings>}>('settings').then(result=>{if(result.settings?.ocrProvider==='auto')return chrome.storage.local.set({settings:{...result.settings,ocrProvider:'wasm'}});}).catch(error=>console.warn('墨譯設定更新',error));
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'comic-translate' && tab?.id != null) void activate(tab.id).then(()=>chrome.tabs.sendMessage(tab.id!,{channel:'open-image',url:info.srcUrl})).catch(()=>chrome.tabs.create({url:chrome.runtime.getURL('/reader.html')}));
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if(message.channel==='runtime-heartbeat'){reply({ok:true});return;}
    if(message.channel==='gemini-status'){
      (async()=>{const {geminiValidation,geminiValidationProgress}=await chrome.storage.local.get(['geminiValidation','geminiValidationProgress']),permission=await chrome.permissions.contains({origins:[geminiOrigin]}),protocolPassed=geminiProtocolPassed(geminiValidation,geminiValidationProgress);return {ok:true,result:{ready:permission&&protocolPassed,permission,protocolPassed}};})().then(reply,e=>reply({ok:false,error:String(e)}));return true;
    }
    if(message.channel==='translation-resume'){googleBlocked=0;googleBlockLoaded=true;chrome.storage.session.remove('googleBlockedStatus').then(()=>reply({ok:true}),e=>reply({ok:false,error:String(e)}));return true;}
    if(message.channel==='gemini-record'){
      if(sender.url!==chrome.runtime.getURL('/offscreen.html'))return;
      storageWrite(async()=>{
        const stored=await chrome.storage.local.get(['geminiJobs','geminiUnknown']),geminiJobs=(stored.geminiJobs??[]) as any[],locks=(stored.geminiUnknown??{}) as Record<string,any>,job=message.job;
        // A valid 120 KB chapter plus the bounded response/raw excerpts can
        // exceed 150,000 characters. Recording success must fit that contract.
        if(typeof job?.requestId!=='string'||typeof job.inputHash!=='string'||JSON.stringify(job).length>400000)throw new Error('Gemini 診斷格式錯誤');
        if(job.status==='submitted'&&(locks[job.inputHash]||geminiJobs.some(j=>j.inputHash===job.inputHash&&['submitted','unknown'].includes(j.status))))throw new Error('相同輸入有結果未知的匿名請求；請先在設定頁確認解除鎖定');
        if(['submitted','unknown'].includes(job.status))locks[job.inputHash]={requestId:job.requestId,pageHash:job.pageHash,status:job.status,at:Date.now()};else if(locks[job.inputHash]?.requestId===job.requestId)delete locks[job.inputHash];
        await chrome.storage.local.set({geminiUnknown:locks,geminiJobs:[job,...geminiJobs.filter(j=>j.requestId!==job.requestId)].slice(0,30)});
      }).then(()=>reply({ok:true}),e=>reply({ok:false,error:String(e)}));return true;
    }
    if(message.channel==='gemini-unlock'){
      if(!sender.url?.startsWith(chrome.runtime.getURL('/options.html')))return;
      if([...leases].some(k=>k.startsWith('gemini:'))){reply({ok:false,error:'匿名請求仍在執行'});return;}
      storageWrite(async()=>{const {geminiJobs=[]}=await chrome.storage.local.get('geminiJobs');await chrome.storage.local.set({geminiUnknown:{},geminiJobs:(geminiJobs as any[]).map(j=>['submitted','unknown'].includes(j.status)?{...j,status:'manually-released',releasedAt:Date.now()}:j)});}).then(()=>reply({ok:true}),e=>reply({ok:false,error:String(e)}));return true;
    }
    if(message.channel==='gemini-validation-progress'){
      if(sender.url!==chrome.runtime.getURL('/offscreen.html'))return;
      storageWrite(()=>chrome.storage.local.set({geminiValidationProgress:{completed:message.completed,total:message.total,sample:message.sample,phase:message.phase}})).then(()=>reply({ok:true}),e=>reply({ok:false,error:String(e)}));return true;
    }
    if(message.channel==='gemini-validate'||message.channel==='gemini-translate'||message.channel==='gemini-refine'||message.channel==='gemini-chapter'){
      const task=async()=>{
        if(maintenance)throw new Error('快取維護中');
        if(!await chrome.permissions.contains({origins:[geminiOrigin]}))throw new Error('請先在設定頁核准匿名 Gemini 網站權限');
        if(message.channel==='gemini-validate'&&!sender.url?.startsWith(chrome.runtime.getURL('/options.html')))throw new Error('請從可見設定頁啟動匿名實測');
        if(message.channel!=='gemini-validate'){const {geminiValidation,geminiValidationProgress}=await chrome.storage.local.get(['geminiValidation','geminiValidationProgress']);if(!geminiProtocolPassed(geminiValidation,geminiValidationProgress))throw new Error('匿名 Gemini 尚未通過 30 批實測；請先在設定頁執行研究驗證');}
        const validating=message.channel==='gemini-validate';if(validating&&geminiValidationRunning)throw new Error('匿名驗證已在另一個設定頁進行');if(validating)geminiValidationRunning=true;
        const id=message.id??crypto.randomUUID(),done=lease('gemini:'+id);
        if(sender.tab?.id!=null)owners.set(id,{tabId:sender.tab.id,frameId:sender.frameId??0});
        try{await offscreen();const response=await chrome.runtime.sendMessage({...message,id,channel:'offscreen-gemini',op:message.channel==='gemini-validate'?'validate':message.channel==='gemini-chapter'?'chapter':message.channel==='gemini-refine'?'refine':'translate'});
          if(message.channel==='gemini-validate'&&response?.ok)await storageWrite(()=>chrome.storage.local.set({geminiValidation:response.result}));
          if(message.channel!=='gemini-validate'&&!response?.ok&&response?.state==='failed')await storageWrite(()=>chrome.storage.local.set({geminiValidation:{status:'blocked',completed:0,required:30,error:response?.error??'匿名翻譯未回應',at:Date.now()}}));return response;
        }finally{if(validating)geminiValidationRunning=false;owners.delete(id);done();}
      };task().then(reply,e=>reply({ok:false,error:String(e)}));return true;
    }
    if(message.channel==='tab-tools-state'){const tabId=sender.tab?.id??message.tabId;chrome.storage.session.get('toolsHidden:'+tabId).then(data=>reply({ok:true,hidden:data['toolsHidden:'+tabId]===true}),e=>reply({ok:false,error:String(e)}));return true;}
    if(message.channel==='tab-tools-visibility'){(async()=>{await chrome.storage.session.set({['toolsHidden:'+message.tabId]:message.hidden===true});try{return await chrome.tabs.sendMessage(message.tabId,{channel:'tools-visibility',hidden:message.hidden===true});}catch{if(message.hidden)return {ok:true};await activate(message.tabId);return chrome.tabs.sendMessage(message.tabId,{channel:'tools-visibility',hidden:false});}})().then(reply,e=>reply({ok:false,error:String(e)}));return true;}
    if(message.channel==='pause-page'){chrome.tabs.sendMessage(message.tabId,{channel:'pause-tools'}).then(reply,e=>reply({ok:false,error:String(e)}));return true;}
    if(message.channel==='activate-page'){chrome.storage.session.set({['toolsHidden:'+message.tabId]:false}).then(()=>activate(message.tabId)).then(()=>chrome.tabs.sendMessage(message.tabId,{channel:'tools-visibility',hidden:false})).then(()=>reply({ok:true}),e=>reply({ok:false,error:String(e)}));return true;}
    if(message.channel==='auto-scripts'){autoScripts().then(()=>reply({ok:true}),e=>reply({ok:false,error:String(e)}));return true;}
    if(message.channel==='runtime-status'){
      (async()=>{if(!await chrome.offscreen.hasDocument()){const value=await chrome.storage.session.get('runtimeReleasedAt');return {ok:true,result:{phase:value.runtimeReleasedAt?'released':'unloaded',worker:false,models:0,busy:leases.size}};}return chrome.runtime.sendMessage({channel:'offscreen-runtime-status'});})().then(reply,e=>reply({ok:false,error:String(e)}));return true;
    }
    if(message.channel==='runtime-release'||message.channel==='runtime-idle-expired'){
      releaseRuntime().then(reply,e=>reply({ok:false,error:String(e)}));return true;
    }
    if(message.channel==='cache-model-record'){
      storageWrite(async()=>{const {cacheSizeIndex={}}=await chrome.storage.local.get('cacheSizeIndex');const r=message.record;if(!r||!Number.isFinite(r.bytes)||r.bytes<0)throw new Error('快取計量格式錯誤');await chrome.storage.local.set({cacheSizeIndex:{...(cacheSizeIndex as object),[recordKey(r.cache,r.url)]:r}});}).then(()=>reply({ok:true}),e=>reply({ok:false,error:String(e)}));return true;
    }
    if(['cache-inventory','cache-scan','cache-remove','cache-model-scan'].includes(message.channel)){
      const work=async()=>{if(message.channel==='cache-inventory')return {ok:true,result:await inventory(),busy:leases.size>0};if(message.channel==='cache-model-scan')return {ok:true,result:await storageWrite(scanCaches)};if(leases.size||maintenance)throw new Error('任務進行中，請先暫停並等待收尾');maintenance=true;try{if(message.channel==='cache-remove')await releaseRuntime();return {ok:true,result:await storageWrite(()=>message.channel==='cache-remove'?removeCache(message.selection):scanCaches())};}finally{maintenance=false;}};
      work().then(reply,e=>reply({ok:false,error:String(e)}));return true;
    }
    if(message.channel==='image-slot-acquire'){
      if(typeof message.id!=='string'||message.id.length>100||sender.tab?.id==null){reply({ok:false,error:'圖片任務來源不合法'});return;}
      if(maintenance){reply({ok:false,error:'快取維護中，請稍後續翻'});return;}
      const done=lease('image:'+message.id);pageLeaseOwners.set(message.id,sender.tab.id);imageSlots.acquire(message.id,sender.tab.id).then(()=>reply({ok:true}),error=>{done();pageLeaseOwners.delete(message.id);reply({ok:false,error:String(error)});});return true;
    }
    if(message.channel==='image-slot-release'){imageSlots.release(message.id);pageLeaseOwners.delete(message.id);leases.delete('image:'+message.id);void syncBusy().catch(()=>{});reply({ok:true});return;}
    if(message.channel==='image-slot-cancel'){imageSlots.cancelWaiting(message.id);reply({ok:true});return;}
    if(message.channel==='cache-page'){
      if(maintenance){reply({ok:false,error:'快取維護中，請稍後儲存'});return;}
      const task=async()=>{const page=message.page;if(!page||page.schema!==1||typeof page.hash!=='string'||!/^[a-f0-9]{64}$/.test(page.hash)||typeof page.modelKey!=='string'||page.modelKey.length>5000||!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width*page.height>30_000_000)throw new Error('頁面快取格式錯誤');importCorrection(page,page.hash,page.width,page.height);await cachePageDirect(page);return {ok:true};};
      task().then(reply,error=>reply({ok:false,error:String(error)}));return true;
    }
    if(message.channel==='progress'){
      const owner=owners.get(message.id);if(owner)void chrome.tabs.sendMessage(owner.tabId,message,{frameId:owner.frameId}).catch(()=>{});return;
    }
    if(message.channel==='open-options'){void chrome.runtime.openOptionsPage();reply({ok:true});return;}
    if(message.channel==='comic-font'){
      fetch(chrome.runtime.getURL('/fonts/NotoSansCJKtc-Regular.otf')).then(async res=>{if(!res.ok)throw new Error('字型讀取失敗');return {ok:true,base64:imageBase64(new Uint8Array(await res.arrayBuffer()))};}).then(reply,error=>reply({ok:false,error:String(error)}));return true;
    }
    if(message.channel==='grant-image'){
      try{const url=publicImageUrl(message.origin);chrome.permissions.request({origins:[`${url.origin}/*`]}).then(ok=>reply({ok}),error=>reply({ok:false,error:String(error)}));}catch(error){reply({ok:false,error:String(error)});}return true;
    }
    if(message.channel==='google-text'){
      if(maintenance){reply({ok:false,error:'快取維護中'});return;}
      const id=typeof message.id==='string'?message.id:crypto.randomUUID(),controller=new AbortController();googleAborts.set(id,controller);
      const done=lease('google:'+id);
      const task=async()=>{
        if(!googleBlockLoaded){googleBlocked=Number((await chrome.storage.session.get('googleBlockedStatus')).googleBlockedStatus)||0;googleBlockLoaded=true;}
        if(googleBlocked)throw new Error(`Google HTTP ${googleBlocked} 後已停止所有後續請求；請稍後手動續翻`);
        if(typeof message.source!=='string'||!message.source.trim()||message.source.length>1500)throw new Error('翻譯原文長度不合法');
        if(!await chrome.permissions.contains({origins:['https://translate.googleapis.com/*']}))throw new Error('Google 文字請求權限未核准');
        const url=new URL('https://translate.googleapis.com/translate_a/single');url.search=new URLSearchParams({client:'gtx',sl:'ja',tl:'zh-TW',dt:'t',q:message.source}).toString();
        const wait=Math.max(0,lastGoogleStart+250-performance.now());if(wait)await new Promise(resolve=>setTimeout(resolve,wait));controller.signal.throwIfAborted();lastGoogleStart=performance.now();
        let res:Response;try{res=await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});}catch(error){controller.signal.throwIfAborted();throw new Error(`Google 文字請求連線失敗：${error instanceof Error?error.message:String(error)}`);}
        if(res.status===403||res.status===429){googleBlocked=res.status;await chrome.storage.session.set({googleBlockedStatus:res.status});}
        return {ok:true,status:res.status,data:res.ok?await res.json():null};
      };googleLane.run(task,controller.signal).finally(()=>{googleAborts.delete(id);done();}).then(reply,error=>reply({ok:false,error:error instanceof Error?error.message:String(error)}));return true;
    }
    if (message.channel === 'register-frame') {
      if (!sender.tab || !sender.url?.startsWith('http') || typeof message.token !== 'string') return;
      const origin = new URL(sender.url).origin;
      const record = { origin, expires: Date.now() + 600_000, tabId: sender.tab.id };
      chrome.storage.session.set({ ['frame:'+message.token]: record }).then(() => reply({ ok: true }), error => reply({ ok: false, error: String(error) }));
      return true;
    }
    if (message.channel === 'frame-authority') {
      if (!sender.url?.startsWith(chrome.runtime.getURL('/reader.html'))) return;
      const key = 'frame:'+message.token;
      chrome.storage.session.get(key).then(result => {
        const entry = result[key] as { origin: string; expires: number; tabId: number } | undefined;
        reply({ ok: !!entry && entry.expires > Date.now() && entry.tabId === sender.tab?.id, origin: entry?.origin });
      }, error => reply({ ok: false, error: String(error) }));
      return true;
    }
    if (message.channel === 'engine') {
      if (sender.url?.endsWith('/offscreen.html')) return;
      let task = jobs.get(message.id);
      if (!task) {
        if(maintenance){reply({ok:false,error:'快取維護中'});return;}
        const done=lease('engine:'+message.id);
        if(sender.tab?.id!=null&&sender.url?.startsWith('http'))owners.set(message.id,{tabId:sender.tab.id,frameId:sender.frameId??0});
        task = offscreen().then(async()=>{const {settings={}}=await chrome.storage.local.get('settings');return chrome.runtime.sendMessage({ ...message,runtimeOptions:{wasmThreads:(settings as Partial<Settings>).wasmThreads??'auto'}, channel: 'offscreen' });}).finally(() => {jobs.delete(message.id);owners.delete(message.id);done();});
        jobs.set(message.id, task);
      }
      task.then(reply, error => reply({ ok: false, error: String(error) })); return true;
    }
    if(message.channel==='native-translate'||message.channel==='native-status'){
      if(maintenance){reply({ok:false,error:'快取維護中'});return;}
      const id=message.id??crypto.randomUUID();if(sender.tab?.id!=null&&sender.url?.startsWith('http'))owners.set(id,{tabId:sender.tab.id,frameId:sender.frameId??0});
      const done=lease('native:'+id);offscreen().then(()=>chrome.runtime.sendMessage({...message,id,channel:'offscreen-native',op:message.channel==='native-status'?'status':'translate'})).finally(()=>{owners.delete(id);done();}).then(reply,error=>reply({ok:false,error:String(error)}));return true;
    }
    if (message.channel === 'cancel') { imageSlots.cancelWaiting(message.id);googleAborts.get(message.id)?.abort();void chrome.runtime.sendMessage({ channel: 'offscreen-cancel', id: message.id }).catch(()=>{}); return; }
    if (message.channel === 'fetch-image') {
      const task = async () => {
        const url = publicImageUrl(message.url);
        const granted = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
        if (!granted) return { ok: false, code:'HOST_ACCESS_REQUIRED',error: `Chrome 已限制圖片網站存取：${url.origin}；請按墨譯圖示的「授權所有網站與圖片 CDN」，再繼續翻譯`, permissionOrigin: `${url.origin}/*` };
        const res = await fetch(url.href, { credentials: 'omit', redirect: 'error', signal:AbortSignal.timeout(15000) });
        if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) throw new Error('無法取得圖片');
        if (Number(res.headers.get('content-length')) > 20 * 1024 * 1024) throw new Error('圖片超過 20 MB');
        const reader = res.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('圖片超過 20 MB'); } chunks.push(value); }
        const data = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        return { ok: true, base64: imageBase64(data), mime: res.headers.get('content-type') };
      };
      task().then(reply, error => reply({ ok: false, error: String(error) })); return true;
    }
  });
});
