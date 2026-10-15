import {mount} from 'svelte';
import CacheManager from '../src/CacheManager.svelte';
import ChapterDock from '../src/ChapterDock.svelte';
import {draggableDock} from '../src/dock-position';
import {IdleRuntime} from '../src/idle-runtime';
declare const BENCH_WORKER:string;
const status=document.querySelector('#status')!,values:any={dockCollapsed:false},listeners=new Set<any>();
let hidden=false,releases=0;
const fixture={pages:[{key:'page:original',title:'原創測試漫畫',hash:'example',chapter:'第一話',pageIndex:0,backend:'google-web',source:'https://example.com/comic',regions:3,bytes:10240,savedAt:Date.now()}],models:[{id:'manga-ocr',cache:'comic-vision-v1',url:'https://example.com/encoder.onnx',version:'fixture-v1',bytes:3456789,measuredAt:Date.now(),verified:true,expected:1}],pageBytes:10240,modelBytes:3456789,unmeasured:0,estimate:{usage:4000000,quota:1000000000}};
(globalThis as any).chrome={runtime:{id:'isolated-ui-fixture',getURL:(p:string)=>location.origin+'/'+p.replace(/^\//,''),sendMessage:async(m:any)=>{if(m.channel==='cache-inventory')return {ok:true,result:structuredClone(fixture),busy:false};if(m.channel==='runtime-status')return {ok:true,result:{phase:releases?'released':'waiting',worker:!releases,models:releases?0:3,threads:1,spawnedPthreads:0,crossOriginIsolated}};if(m.channel==='runtime-release'){releases++;return {ok:true};}if(m.channel==='cache-scan')return {ok:true,result:structuredClone(fixture)};throw Error('fixture does not support '+m.channel);}},storage:{local:{get:async(k:string)=>({[k]:values[k]}),set:async(v:any)=>Object.assign(values,v)},onChanged:{addListener:(f:any)=>listeners.add(f),removeListener:(f:any)=>listeners.delete(f)}}};
mount(CacheManager,{target:document.querySelector('#manager')!});
const holder=document.querySelector<HTMLElement>('#dock')!;
mount(ChapterDock,{target:holder,props:{getImages:()=>[],runChapter:async()=>{},onRunning:()=>{},openChapter:()=>{status.textContent='已開啟測試工作台';},toggleOriginal:()=>{status.textContent='已切換測試原圖';}}});
draggableDock(holder,p=>{values.dockPosition=p;document.querySelector('#position')!.textContent=JSON.stringify(p);});
document.querySelector('#visibility')!.addEventListener('click',()=>{hidden=!hidden;holder.style.display=hidden?'none':'';status.textContent=hidden?'工具已隱藏':'工具已顯示';});
document.querySelector('#idle')!.addEventListener('click',()=>{const idle=new IdleRuntime(()=>{releases++;status.textContent='模型已釋放（短計時 fixture）';idle.dispose();},100);idle.activity(1);idle.activity(0);});
document.querySelector('#threads')!.addEventListener('click',async()=>{
 const files=await fetch('/tensor-index.json').then(r=>r.json()),results=[];let last=performance.now(),lag:number[]=[];const timer=setInterval(()=>{const now=performance.now();lag.push(Math.max(0,now-last-50));last=now;},50);
 try{for(const threads of [1,2,4]){status.textContent=`固定輸入張量：WASM ${threads} 執行緒`;const worker=new Worker(BENCH_WORKER,{type:'module'});try{const result:any=await new Promise((resolve,reject)=>{worker.onmessage=({data})=>{if(data.type==='progress'){status.textContent=`WASM ${threads} 執行緒，第 ${data.run+1}/4 輪`;return;}resolve(data);};worker.onerror=e=>reject(Error(e.message));worker.postMessage({threads,files});});results.push(result);document.querySelector('#results')!.textContent=JSON.stringify(results,null,2);await fetch('/report/threads',{method:'POST',body:JSON.stringify({results,eventLoopLagMs:lag,scope:'localhost COI benchmark Worker; extension offscreen checked separately'})});if(!result.ok)break;}finally{worker.terminate();}}status.textContent='WASM 固定張量量測完成';}catch(e){status.textContent=String(e);}finally{clearInterval(timer);}
});
document.querySelector('#finish')!.addEventListener('click',()=>{void fetch('/finish',{method:'POST'}).then(()=>status.textContent='伺服器已結束');});
