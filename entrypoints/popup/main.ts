import '../../src/studio-theme.css';
import {requestAllWebAccess,allWebOrigins} from '../../src/site-access';

const button=(id:string)=>document.getElementById(id) as HTMLButtonElement;
const primary=button('primary'),visibility=button('visibility'),pause=button('pause'),grant=button('grant');
const text=document.getElementById('status')!,tabState=document.getElementById('tab-state')!,access=document.getElementById('access-state')!;
let tab:chrome.tabs.Tab|undefined,tools:{hidden:boolean;hasImages:boolean}|undefined,inFlight=false;
function report(message:string,error=false){
  text.hidden=false;text.textContent=message;text.className=error?'mx-alert':'mx-note';
}
async function inspect(){
  [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const web=tab?.id!=null&&/^https?:/.test(tab.url??'');
  const active=web?await chrome.tabs.sendMessage(tab!.id!,{channel:'page-tools-state'}).catch(()=>undefined):undefined;
  tools=active?.ok?active:undefined;
  primary.hidden=!web||!!tools&&!tools.hidden;
  primary.textContent=tools?.hidden?'顯示工具列':'啟用本頁墨譯';
  visibility.hidden=!tools||tools.hidden;
  pause.hidden=!tools;
  tabState.textContent=!web?'切到漫畫網站即可啟用，或開啟本機工作台。':!tools?'這個分頁尚未啟用墨譯。':tools.hidden?'這個分頁的工具列已隱藏。':tools.hasImages?'本頁墨譯已啟用，可從漫畫頁開始翻譯。':'本頁墨譯已啟用，捲動到漫畫圖片後即可操作。';
  access.textContent=await chrome.permissions.contains({origins:allWebOrigins})?'網站與圖片 CDN 已授權':'Chrome 已限制部分網站存取';
}
async function action(work:()=>Promise<void>){
  if(inFlight)return;
  inFlight=true;primary.disabled=visibility.disabled=pause.disabled=grant.disabled=true;
  try{await work();await inspect();}
  catch(error){report(error instanceof Error?error.message:String(error),true);}
  finally{inFlight=false;primary.disabled=visibility.disabled=pause.disabled=grant.disabled=false;}
}
async function send(channel:string,extra:object={}){
  if(tab?.id==null)throw new Error('請先切回漫畫分頁。');
  const result=await chrome.runtime.sendMessage({channel,tabId:tab.id,...extra});
  if(!result?.ok)throw new Error(result?.error??'漫畫頁未回應，請重新整理後啟用。');
}
primary.onclick=()=>void action(async()=>{
  if(tools?.hidden){await send('tab-tools-visibility',{hidden:false});report('工具列已顯示。');return;}
  if(!await requestAllWebAccess()){report('網站存取未核准。可在 Chrome 調整擴充套件的網站存取。',true);return;}
  await send('activate-page');report('已啟用本頁。漫畫圖片旁會顯示墨譯工具。');
});
visibility.onclick=()=>void action(async()=>{await send('tab-tools-visibility',{hidden:true});report('已隱藏本頁工具列。');});
pause.onclick=()=>void action(async()=>{await send('pause-page');report('已暫停本頁排程。手上的任務收尾後會釋放模型。');});
grant.onclick=()=>void action(async()=>{
  const granted=await requestAllWebAccess();
  report(granted?'已授權網站與圖片 CDN，可啟用或繼續翻譯。':'網站存取未核准，可在 Chrome 調整。',!granted);
});
button('reader').onclick=()=>void chrome.tabs.create({url:chrome.runtime.getURL('/reader.html')}).catch(error=>report(String(error),true));
button('settings').onclick=()=>void chrome.runtime.openOptionsPage().catch(error=>report(String(error),true));
button('cache').onclick=()=>void chrome.tabs.create({url:chrome.runtime.getURL('/cache.html')}).catch(error=>report(String(error),true));
void inspect().catch(error=>report(String(error),true));