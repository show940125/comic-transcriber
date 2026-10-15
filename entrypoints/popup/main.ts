import {requestAllWebAccess,allWebOrigins} from '../../src/site-access';
document.getElementById('reader')!.onclick = () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/reader.html') }); };
document.getElementById('settings')!.onclick = () => { void chrome.runtime.openOptionsPage(); };
document.getElementById('cache')!.onclick=()=>{void chrome.tabs.create({url:chrome.runtime.getURL('/cache.html')});};
async function pageAction(channel:string,extra:object={}){try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||!/^https?:/.test(tab.url??''))throw new Error('請在漫畫網站使用');const result=await chrome.runtime.sendMessage({channel,tabId:tab.id,...extra});if(!result?.ok)throw new Error(result?.error??'本頁尚未啟用墨譯');document.getElementById('status')!.textContent='已完成';}catch(e){document.getElementById('status')!.textContent=String(e);}}
document.getElementById('activate')!.onclick=()=>{void requestAllWebAccess().then(ok=>{if(ok)return pageAction('activate-page');document.getElementById('status')!.textContent='請允許所有網站存取後再啟用。';}).catch(e=>{document.getElementById('status')!.textContent=String(e);});};
document.getElementById('pause')!.onclick=()=>{void pageAction('pause-page');};
document.getElementById('visibility')!.onclick=()=>{void (async()=>{try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id)return;const state=await chrome.runtime.sendMessage({channel:'tab-tools-state',tabId:tab.id});await pageAction('tab-tools-visibility',{hidden:!state.hidden});}catch(e){document.getElementById('status')!.textContent=String(e);}})();};
document.getElementById('grant')!.onclick = async () => {
  try {
    if(!await requestAllWebAccess()){document.getElementById('status')!.textContent='網站存取未核准。';return;}
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if(tab?.id&&/^https?:/.test(tab.url??''))await chrome.tabs.reload(tab.id);
    document.getElementById('status')!.textContent = '所有網站與圖片 CDN 已授權，可啟用或繼續翻譯。';
  } catch (e) { document.getElementById('status')!.textContent = String(e); }
};
void chrome.permissions.contains({origins:allWebOrigins}).then(ok=>{if(ok)document.getElementById('access-state')!.textContent='所有網站與圖片 CDN 已授權';}).catch(()=>{});
