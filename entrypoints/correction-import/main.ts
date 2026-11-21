import '../../src/studio-theme.css';
import {importCorrection} from '../../src/core';
import {correctionFileLimit,type CorrectionBinding} from '../../src/correction-import';
import type {Region} from '../../src/types';
const file=document.querySelector<HTMLInputElement>('#file')!,submit=document.querySelector<HTMLButtonElement>('#submit')!,status=document.querySelector<HTMLElement>('#status')!;
const summary=document.getElementById('summary')!,filename=document.getElementById('file-name')!,count=document.getElementById('region-count')!;
let binding:CorrectionBinding|undefined,regions:Region[]|undefined,submitted=false,selection=0;
const id=location.hash.slice(1);
async function call(channel:string,extra:object={}){const result=await chrome.runtime.sendMessage({channel,id,...extra});if(!result?.ok)throw Error(result?.error??'校正匯入未回應');return result;}
if(parent!==window||location.protocol!=='chrome-extension:'||location.host!==chrome.runtime.id){status.textContent='請從漫畫頁工作台開啟獨立匯入分頁';}
else{
  void call('correction-import-read').then(result=>{if(result.state!=='ready')throw Error('這次匯入已提交，請從原工作台重新開啟');binding=result.binding;file.disabled=false;status.textContent='請選擇校正 JSON';}).catch(error=>{status.textContent=String(error);});
  file.onchange=async()=>{
    const mine=++selection;regions=undefined;submit.disabled=true;summary.hidden=true;const input=file.files?.[0];
    status.className='';status.textContent=input?'正在核對圖片與文字框…':'請選擇校正 JSON';
    try{
      if(!binding||submitted||!input)return;
      if(input.size>correctionFileLimit)throw Error('校正檔超過 2 MB');
      const data=JSON.parse(await input.text()),checked=importCorrection(data,binding.hash,binding.width,binding.height);
      if(mine!==selection||submitted)return;
      regions=checked;filename.textContent=input.name;count.textContent=String(checked.length);summary.hidden=false;
      status.textContent=`已核對 ${checked.length} 個文字框，可確認後匯入。`;submit.disabled=false;
    }catch(error){if(mine===selection){status.className='mx-alert';status.textContent=error instanceof Error?error.message:String(error);}}
  };
  submit.onclick=async event=>{
    if(!event.isTrusted||submitted||!regions)return;submitted=true;submit.disabled=true;file.disabled=true;
    status.textContent='正在保存至原工作台…';
    try{
      await call('correction-import-submit',{regions});regions=undefined;file.value='';
      status.textContent='已匯入工作台。回到工作台按「套用至漫畫頁」即可更新網頁譯圖。';
    }catch(error){
      status.className='mx-alert';status.textContent=(error instanceof Error?error.message:String(error))+'。請回原工作台確認匯入狀態，再決定是否重新開啟匯入。';
    }
  };
}
