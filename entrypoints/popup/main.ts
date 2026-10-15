document.getElementById('reader')!.onclick = () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/reader.html') }); };
document.getElementById('settings')!.onclick = () => { void chrome.runtime.openOptionsPage(); };
document.getElementById('cache')!.onclick=()=>{void chrome.tabs.create({url:chrome.runtime.getURL('/cache.html')});};
async function pageAction(channel:string,extra:object={}){try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||!/^https?:/.test(tab.url??''))throw new Error('請在漫畫網站使用');const result=await chrome.runtime.sendMessage({channel,tabId:tab.id,...extra});if(!result?.ok)throw new Error(result?.error??'本頁尚未啟用墨譯');document.getElementById('status')!.textContent='已完成';}catch(e){document.getElementById('status')!.textContent=String(e);}}
document.getElementById('activate')!.onclick=()=>{void pageAction('activate-page');};
document.getElementById('pause')!.onclick=()=>{void pageAction('pause-page');};
document.getElementById('visibility')!.onclick=()=>{void (async()=>{try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id)return;const state=await chrome.runtime.sendMessage({channel:'tab-tools-state',tabId:tab.id});await pageAction('tab-tools-visibility',{hidden:!state.hidden});}catch(e){document.getElementById('status')!.textContent=String(e);}})();};
document.getElementById('grant')!.onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.id) throw new Error('請在漫畫網站使用此功能');
    const url = new URL(tab.url); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('請開啟 HTTP(S) 漫畫網站');
    if (await chrome.permissions.request({ origins: [`${url.origin}/*`] })) { await chrome.tabs.reload(tab.id); document.getElementById('status')!.textContent = '已授權並重新整理。'; }
  } catch (e) { document.getElementById('status')!.textContent = String(e); }
};
