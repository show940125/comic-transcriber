import { defineBackground } from 'wxt/utils/define-background';
import { publicImageUrl } from '../src/core';
import { imageBase64 } from '../src/binary';
export default defineBackground(() => {
  let creating: Promise<void> | undefined;
  const jobs = new Map<string, Promise<unknown>>();
  const owners = new Map<string,{tabId:number;frameId:number}>();
  async function offscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    creating ??= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: '離線漫畫模型的專用推論 Worker' }).finally(() => { creating = undefined; });
    await creating;
  }
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: 'comic-translate', title: '墨譯：翻譯這張漫畫', contexts: ['image'] });
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'comic-translate' && tab?.id != null) void chrome.tabs.sendMessage(tab.id, { channel: 'open-image', url: info.srcUrl }).catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('/reader.html') }));
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
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
      const task=async()=>{
        if(typeof message.source!=='string'||!message.source.trim()||message.source.length>1500)throw new Error('翻譯原文長度不合法');
        if(!await chrome.permissions.contains({origins:['https://translate.googleapis.com/*']}))throw new Error('Google 文字請求權限未核准');
        const url=new URL('https://translate.googleapis.com/translate_a/single');url.search=new URLSearchParams({client:'gtx',sl:'ja',tl:'zh-TW',dt:'t',q:message.source}).toString();
        let res:Response;try{res=await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});}catch(error){throw new Error(`Google 文字請求連線失敗：${error instanceof Error?error.message:String(error)}`);}
        return {ok:true,status:res.status,data:res.ok?await res.json():null};
      };task().then(reply,error=>reply({ok:false,error:error instanceof Error?error.message:String(error)}));return true;
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
        if(sender.tab?.id!=null&&sender.url?.startsWith('http'))owners.set(message.id,{tabId:sender.tab.id,frameId:sender.frameId??0});
        task = offscreen().then(() => chrome.runtime.sendMessage({ ...message, channel: 'offscreen' })).finally(() => {jobs.delete(message.id);owners.delete(message.id);});
        jobs.set(message.id, task);
      }
      task.then(reply, error => reply({ ok: false, error: String(error) })); return true;
    }
    if (message.channel === 'cancel') { void chrome.runtime.sendMessage({ channel: 'offscreen-cancel', id: message.id }); return; }
    if (message.channel === 'fetch-image') {
      const task = async () => {
        const url = publicImageUrl(message.url);
        const granted = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
        if (!granted) return { ok: false, error: `圖片來源尚未授權：${url.origin}`, permissionOrigin: `${url.origin}/*` };
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
