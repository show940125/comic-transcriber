import {defaults,type Diagnostic} from '../src/types';
import {loadSession,processSession,encodeSession} from '../src/page-pipeline';
import {SerialLane,runPool} from '../src/scheduling';
import {cachePageDirect} from '../src/storage';import {imageBytes} from '../src/binary';
declare const CHAPTER_FILES:string[],ENGINE_WORKER:string;
const status=document.querySelector('#status')!,metrics=document.querySelector('#metrics')!,button=document.querySelector<HTMLButtonElement>('#run')!,native=document.querySelector<HTMLInputElement>('#native')!;
const values:Record<string,any>={},listeners=new Set<any>(),pending=new Map<string,(data:any)=>void>(),google=new SerialLane();let worker:Worker,threads=1,active=0,peak=0,lastGoogle=0,googleActive=0,googlePeak=0;
function boot(){worker=new Worker(ENGINE_WORKER,{type:'module'});worker.onmessage=({data})=>{if(data.type==='progress'){for(const listener of listeners)listener({channel:'progress',id:data.id,diagnostic:data.diagnostic});return;}if(data.type)return;pending.get(data.id)?.(data);pending.delete(data.id);};worker.onerror=e=>{for(const reply of pending.values())reply({ok:false,error:e.message});pending.clear();};}
(globalThis as any).chrome={runtime:{id:'chapter-fixture',getURL:(p:string)=>location.origin+'/'+p.replace(/^\//,''),onMessage:{addListener:(f:any)=>listeners.add(f),removeListener:(f:any)=>listeners.delete(f)},sendMessage:async(m:any)=>{
 if(m.channel==='cache-page'){await cachePageDirect(m.page);return {ok:true};}
 if(m.channel==='cancel'){worker.postMessage({cancel:m.id});return;}
 if(m.channel==='google-text')return google.run(async()=>{googleActive++;googlePeak=Math.max(googlePeak,googleActive);try{const delay=Math.max(0,lastGoogle+250-performance.now());if(delay)await new Promise(r=>setTimeout(r,delay));lastGoogle=performance.now();await new Promise(r=>setTimeout(r,300));return {ok:true,status:200,data:[[['這是一段用於速度比較的繁體中文對白。',null]],null,'ja']};}finally{googleActive--;}});
 if(m.channel==='engine'){const request={...m.request};if(typeof request.image==='string')request.image=new Blob([imageBytes(request.image)],{type:request.mime});return new Promise(resolve=>{pending.set(m.id,resolve);worker.postMessage({id:m.id,request,base:location.origin+'/',runtimeOptions:{wasmThreads:threads}});});}
 throw Error('unsupported fixture '+m.channel);
}},storage:{local:{get:async(keys:any)=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in values).map(k=>[k,structuredClone(values[k])])),set:async(v:any)=>Object.assign(values,structuredClone(v)),remove:async(keys:string[])=>keys.forEach(k=>delete values[k])}}};
async function chapter(mode:string,run:number){for(const key of Object.keys(values))delete values[key];peak=googlePeak=0;const events:Diagnostic[]=[],pages:any[]=[],start=performance.now();
 await runPool(CHAPTER_FILES,2,async(file,index)=>{active++;peak=Math.max(peak,active);const begin=performance.now(),blob=await fetch('/pages/'+file).then(r=>r.blob()),session=await loadSession(blob,{...defaults,localOcr:mode==='native-4',ocrEndpoint:native.value,ocrProvider:'wasm'});try{
  await processSession(session,{progress:d=>{status.textContent=`${mode} · ${run===0?'冷啟動':'暖機 '+run} · ${index+1}/17 · ${d.message}`;events.push({...d,pageIndex:index});}});const encoding=performance.now();await encodeSession(session,false);pages.push({file,ms:performance.now()-begin,encodeMs:performance.now()-encoding,regions:session.regions.map(r=>({id:r.id,source:r.source}))});
 }finally{session.dispose();active--;}
 },{stopped:()=>false});
 const id=crypto.randomUUID(),info:any=await new Promise(resolve=>{pending.set(id,resolve);worker.postMessage({id,request:{op:'runtime-info'},base:location.origin+'/',runtimeOptions:{wasmThreads:threads}});});return {mode,run,cold:run===0,ms:performance.now()-start,events,pages,maxInFlight:peak,maxGoogleRequests:googlePeak,runtime:info.result};
}
button.addEventListener('click',async()=>{button.disabled=true;const results:any[]=[],lag:number[]=[];let last=performance.now();const timer=setInterval(()=>{const now=performance.now();lag.push(Math.max(0,now-last-50));last=now;},50);
 try{for(const mode of ['wasm-1','wasm-4','native-4']){threads=mode==='wasm-4'?4:1;boot();try{for(let run=0;run<4;run++){const result=await chapter(mode,run);results.push(result);metrics.textContent=JSON.stringify(results.map(r=>({mode:r.mode,run:r.run,ms:r.ms,runtime:r.runtime})),null,2);await fetch('/report/chapter-threads',{method:'POST',body:JSON.stringify({status:'running',results,eventLoopLagMs:lag})});}}finally{worker.terminate();}}status.textContent='完整比較完成';await fetch('/report/chapter-threads',{method:'POST',body:JSON.stringify({status:'passed',results,eventLoopLagMs:lag,translation:'controlled fixture, 300ms, global serial; no external requests',inputPages:17})});
 }catch(e){status.textContent='比較失敗：'+String(e);await fetch('/report/chapter-threads',{method:'POST',body:JSON.stringify({status:'failed',results,error:String(e),eventLoopLagMs:lag})});}finally{clearInterval(timer);button.disabled=false;}
});
