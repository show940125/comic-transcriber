import {importCorrection} from './core';
import type {Region} from './types';

export interface CorrectionBinding {editorId:string;hash:string;width:number;height:number}
type Sender=chrome.runtime.MessageSender;
export interface CorrectionImportSession extends CorrectionBinding {
  id:string;tabId:number;frameId:number;documentId?:string;sourceUrl:string;
  importTabId?:number;expires:number;state:'ready'|'submitting'|'unknown';created?:Promise<void>;
}
interface Dependencies {
  extensionId:string;pageUrl:string;now?:()=>number;uuid?:()=>string;
  createTab:(url:string)=>Promise<number>;
  deliver:(session:CorrectionImportSession,regions:Region[])=>Promise<{ok?:boolean;error?:string}>;
  activateTab:(tabId:number)=>Promise<unknown>;
}
export const correctionImportLifetime=600_000;
export const correctionFileLimit=2*1024*1024;
export function correctionBinding(value:any):CorrectionBinding {
  if(!value||typeof value.editorId!=='string'||!/^[a-f0-9-]{36}$/i.test(value.editorId)||typeof value.hash!=='string'||!/^[a-f0-9]{64}$/.test(value.hash)||![value.width,value.height].every(n=>Number.isInteger(n)&&n>0)||value.width*value.height>30_000_000)throw Error('校正匯入目標不合法');
  return {editorId:value.editorId,hash:value.hash,width:value.width,height:value.height};
}
export function correctionRegions(value:unknown,binding:CorrectionBinding):Region[]{
  if(JSON.stringify(value)?.length>correctionFileLimit)throw Error('校正資料超過 2 MB');
  return importCorrection({schema:1,hash:binding.hash,width:binding.width,height:binding.height,regions:value},binding.hash,binding.width,binding.height);
}
export class CorrectionImportBroker {
  private sessions=new Map<string,CorrectionImportSession>();
  private now:()=>number;
  constructor(private deps:Dependencies){this.now=deps.now??Date.now;}
  private current(id:string){const s=this.sessions.get(id);if(!s||s.expires<=this.now()){this.sessions.delete(id);throw Error('校正匯入已失效，請從原工作台重新開啟');}return s;}
  private owner(s:CorrectionImportSession,sender:Sender){return sender.tab?.id===s.tabId&&(sender.frameId??0)===s.frameId&&sender.url===s.sourceUrl&&(!s.documentId||sender.documentId===s.documentId);}
  private async importer(id:string,sender:Sender){
    let s=this.current(id);await s.created;s=this.current(id);
    if(sender.tab?.id!==s.importTabId||sender.frameId!==0||sender.url!==this.deps.pageUrl+'#'+s.id)throw Error('校正匯入分頁不符');return s;
  }
  invalidateTab(tabId:number){for(const [id,s]of this.sessions)if(s.tabId===tabId||s.importTabId===tabId)this.sessions.delete(id);}
  navigating(tabId:number,change:{status?:string;url?:string}){for(const [id,s]of this.sessions){if(s.tabId===tabId&&(change.status==='loading'||change.url&&change.url!==s.sourceUrl)||s.importTabId===tabId&&change.url&&change.url!==this.deps.pageUrl+'#'+id)this.sessions.delete(id);}}
  async dispatch(message:any,sender:Sender):Promise<any>{
    if(sender.id!==this.deps.extensionId)throw Error('校正匯入來源不符');
    if(message.channel==='correction-import-open'){
      if(sender.tab?.id==null||!/^https?:\/\//.test(sender.url??''))throw Error('請從漫畫頁工作台開啟校正匯入');
      const binding=correctionBinding(message.binding);
      for(const [id,s]of this.sessions)if(s.expires<=this.now()||this.owner(s,sender)&&s.editorId===binding.editorId)this.sessions.delete(id);
      const id=this.deps.uuid?this.deps.uuid():crypto.randomUUID(),s:CorrectionImportSession={...binding,id,tabId:sender.tab.id,frameId:sender.frameId??0,documentId:sender.documentId,sourceUrl:sender.url!,expires:this.now()+correctionImportLifetime,state:'ready'};
      this.sessions.set(id,s);
      s.created=this.deps.createTab(this.deps.pageUrl+'#'+id).then(tabId=>{s.importTabId=tabId;});
      try{await s.created;this.current(id);return {ok:true};}catch(error){this.sessions.delete(id);throw error;}
    }
    if(message.channel==='correction-import-invalidate'){
      for(const [id,s]of this.sessions)if(this.owner(s,sender)&&s.editorId===message.editorId)this.sessions.delete(id);return {ok:true};
    }
    const s=await this.importer(message.id,sender);
    if(message.channel==='correction-import-read')return {ok:true,binding:{editorId:s.editorId,hash:s.hash,width:s.width,height:s.height},expires:s.expires,state:s.state};
    if(message.channel!=='correction-import-submit')throw Error('校正匯入操作不合法');
    if(s.state!=='ready')throw Error('這次匯入已提交，請勿重送；必要時從原工作台重新開啟');
    const regions=correctionRegions(message.regions,s);s.state='submitting';
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const result=await Promise.race([this.deps.deliver(s,regions),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('原工作台未確認結果；不自動重送')),15_000);})]);
      if(this.current(s.id)!==s)throw Error('原工作台已失效');
      if(!result?.ok)throw Error(result?.error??'原工作台未接受校正');
      this.sessions.delete(s.id);await this.deps.activateTab(s.tabId).catch(()=>{});return {ok:true};
    }catch(error){s.state='unknown';throw error;}finally{clearTimeout(timer);}
  }
}
export function installCorrectionImports(){
  const broker=new CorrectionImportBroker({extensionId:chrome.runtime.id,pageUrl:chrome.runtime.getURL('/correction-import.html'),
    createTab:async url=>{const tab=await chrome.tabs.create({url});if(tab.id==null)throw Error('無法開啟校正匯入');return tab.id;},
    deliver:(s,regions)=>chrome.tabs.sendMessage(s.tabId,{channel:'correction-import-deliver',id:s.id,binding:{editorId:s.editorId,hash:s.hash,width:s.width,height:s.height},regions,sourceUrl:s.sourceUrl},s.documentId?{documentId:s.documentId}:{frameId:s.frameId}),
    activateTab:tabId=>chrome.tabs.update(tabId,{active:true})});
  chrome.tabs.onRemoved.addListener(tabId=>broker.invalidateTab(tabId));
  chrome.tabs.onUpdated.addListener((tabId,change)=>broker.navigating(tabId,change));
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(!['correction-import-open','correction-import-read','correction-import-submit','correction-import-invalidate'].includes(message?.channel))return;
    broker.dispatch(message,sender).then(reply,error=>reply({ok:false,error:String(error)}));return true;
  });
}
