import {defaults,type Region,type Diagnostic} from '../src/types';
import {loadSession,detectSession,ocrSession,processSession,encodeSession,type PageSession} from '../src/page-pipeline';
import {cachePageDirect} from '../src/storage';
import {SerialLane,runPool} from '../src/scheduling';
import {imageBytes} from '../src/binary';
import {renderPage,loadFont} from '../src/render';
import {layoutText} from '../src/text-layout';
import {chromeTranslatorAvailability,prepareChromeTranslator,chromeTranslate,disposeChromeTranslator} from '../src/chrome-translator';
declare const REGRESSION_FILES:string[],REGRESSION_WORKER:string;
const status=document.querySelector('#status')!,metrics=document.querySelector('#metrics')!,output=document.querySelector('#output')!;
const buttons=[...document.querySelectorAll<HTMLButtonElement>('button')];
const values:Record<string,any>={},listeners=new Set<(m:any)=>void>(),pending=new Map<string,(data:any)=>void>(),googleLane=new SerialLane();
let worker:Worker,fixture=false,googleActive=0,googlePeak=0,workerActive=0,workerPeak=0,lastGoogle=0;
const executing=new Set<string>();let executionPeak=0;
const memory=()=>({usedJSHeapSize:(performance as any).memory?.usedJSHeapSize??null,totalJSHeapSize:(performance as any).memory?.totalJSHeapSize??null});
const sampleTranslations=new Map<string,string>();
function bootWorker(){
 worker=new Worker(REGRESSION_WORKER,{type:'module'});worker.onmessage=({data})=>{if(data.type==='progress'){executing.add(data.id);executionPeak=Math.max(executionPeak,executing.size);for(const listener of listeners)listener({channel:'progress',id:data.id,diagnostic:data.diagnostic});return;}executing.delete(data.id);workerActive--;pending.get(data.id)?.(data);pending.delete(data.id);};
 worker.onerror=event=>{for(const resolve of pending.values())resolve({ok:false,error:event.message});pending.clear();workerActive=0;};
}
bootWorker();
(globalThis as any).chrome={runtime:{id:'private-regression',getURL:(resource:string)=>location.origin+'/'+resource.replace(/^\//,''),onMessage:{addListener:(f:any)=>listeners.add(f),removeListener:(f:any)=>listeners.delete(f)},sendMessage:async(message:any)=>{
 if(message.channel==='cache-page'){await cachePageDirect(message.page);return {ok:true};}
 if(message.channel==='cancel'){worker.postMessage({cancel:message.id});return;}
 if(message.channel==='google-text')return googleLane.run(async()=>{googleActive++;googlePeak=Math.max(googlePeak,googleActive);try{const spacing=Math.max(0,lastGoogle+250-performance.now());if(spacing)await new Promise(r=>setTimeout(r,spacing));lastGoogle=performance.now();if(fixture){await new Promise(r=>setTimeout(r,300));return {ok:true,status:200,data:[[[sampleTranslations.get(message.source)??'這個故事的對白，翻成繁體中文。',null]],null,'ja']};}const result=await fetch('/google',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:message.source})}).then(r=>r.json());if(result.ok&&result.status===200)sampleTranslations.set(message.source,result.data[0].map((r:any)=>r[0]).join(''));return result;}finally{googleActive--;}});
 if(message.channel==='engine'){let request={...message.request};if(typeof request.image==='string')request.image=new Blob([imageBytes(request.image)],{type:request.mime});return new Promise(resolve=>{pending.set(message.id,resolve);workerActive++;workerPeak=Math.max(workerPeak,workerActive);worker.postMessage({id:message.id,request,base:location.origin+'/'});});}
 if(message.channel==='native-translate'){const result=await chromeTranslate(message.regions);return {ok:true,result};}
 throw new Error('Unsupported fixture channel '+message.channel);
}},storage:{local:{get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in values).map(k=>[k,structuredClone(values[k])])),set:async(data:any)=>{Object.assign(values,structuredClone(data));},remove:async(keys:string[])=>{for(const key of keys)delete values[key];}}}};
const saveReport=async(data:any)=>{metrics.textContent=JSON.stringify(data,null,2);await fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});};
const locked=async(work:()=>Promise<void>)=>{buttons.forEach(b=>b.disabled=true);try{await work();}catch(error){status.textContent='failed: '+String(error);await saveReport({kind:'error',error:String(error)});}finally{buttons.forEach(b=>b.disabled=false);}};
async function pageSession(file:string){const blob=await fetch('/pages/'+file).then(r=>r.blob());return loadSession(blob,{...defaults,backend:'google-web',ocrProvider:'wasm'});}
function compareRow(label:string,image:HTMLImageElement,regions:Region[]){
 const section=document.createElement('section');
 for(const [name,canvas]of [['原圖',renderPage(image,[],true)],['0.1.9',renderPage(image,regions)]] as const){const figure=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=label+' · '+name;figure.append(caption,canvas);section.append(figure);}output.append(section);
}
async function visual(){
 fixture=false;output.replaceChildren();const results=[];await loadFont();
 for(const file of ['3.jpg','4.jpg']){for(const k of Object.keys(values))delete values[k];const session=await pageSession(file);try{await processSession(session,{progress:d=>{status.textContent=`第 ${file} · ${d.message}`;}});const png=await encodeSession(session,false);compareRow(file,session.image,session.regions);const layout=session.regions.filter(r=>r.translation).map(r=>({id:r.id,source:r.source,translation:r.translation,layout:layoutText(document.createElement('canvas').getContext('2d')!,r.translation,r.bubbleBox??r.ocrBox??r,r.textDirection,r.fontScale)}));results.push({file,hash:session.hash,regions:session.regions,layout,pngBytes:png.byteLength});}finally{session.dispose();}}
 await saveReport({kind:'visual',scope:'two actual local manga pages; production detector/OCR; actual Google text requests; no independent OCR truth',results});status.textContent='visual completed';
}
async function chapter(limit:1|2,label:string){
 for(const key of Object.keys(values))delete values[key];googlePeak=workerPeak=executionPeak=0;let active=0,peak=0;const events:Diagnostic[]=[],started=performance.now(),pages:any[]=[];
 await runPool(REGRESSION_FILES,limit,async(file,index)=>{active++;peak=Math.max(peak,active);const pageStarted=performance.now(),session=await pageSession(file);try{await processSession(session,{progress:d=>{events.push({...d,pageIndex:index});status.textContent=`${label} · 第 ${index+1}/${REGRESSION_FILES.length} 張 · ${d.message}`;}});await encodeSession(session,false);pages.push({file,ms:performance.now()-pageStarted,regions:session.regions.length});}finally{session.dispose();active--;}},{stopped:()=>false});
 return {label,limit,ms:performance.now()-started,pages,events,maxInFlight:peak,maxGoogleRequests:googlePeak,maxWorkerExecutions:executionPeak,maxOutstandingWorkerRequests:workerPeak,memory:memory()};
}
async function benchmark(){
 fixture=true;output.replaceChildren();worker.terminate();bootWorker();
 const cold=await chapter(1,'冷啟動'),runs=[];
 for(let i=0;i<5;i++)for(const limit of (i%2?[2,1]:[1,2]) as Array<1|2>){runs.push(await chapter(limit,`暖機 ${i+1} · ${limit} 張`));await saveReport({kind:'benchmark',status:'running',cold,runs});}
 const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)],one=median(runs.filter(r=>r.limit===1).map(r=>r.ms)),two=median(runs.filter(r=>r.limit===2).map(r=>r.ms));
 await saveReport({kind:'benchmark',status:'passed',scope:'17 actual page inputs; real ONNX and rendering; controlled translation fixture, 300ms per request, global serial lane; page cache reset each run; one shared vision Worker',cold,runs,serialMedianMs:one,pipelineMedianMs:two,speedup:one/two,memoryBoundary:'JS heap only; includes neither all WASM/GPU nor browser-process memory'});status.textContent='benchmark completed';
}
async function native(){
 const [state]=await Promise.all([chromeTranslatorAvailability(),prepareChromeTranslator()]);
 const visual=await fetch('/visual.json').then(r=>r.ok?r.json():null).catch(()=>null);const regions:Region[]=visual?.results.flatMap((r:any)=>r.regions)??[];
 const input=regions.filter(r=>r.source.trim()&&!r.needsReview),started=performance.now(),translated=await chromeTranslate(input);
 await saveReport({kind:'native',availability:state,status:'passed',scope:'production native helper on localhost; extension-offscreen acceptance recorded separately',ms:performance.now()-started,regions:translated.map(r=>({id:r.id,source:r.source,google:input.find(x=>x.id===r.id)?.translation,chrome:r.translation})),humanQualityReview:'pending'});status.textContent='native completed';disposeChromeTranslator();
}
async function storedVisual(){
 const saved=await fetch('/visual.json').then(r=>r.json());output.replaceChildren();await loadFont();
 for(const item of saved.results){const session=await pageSession(item.file);try{compareRow(item.file,session.image,item.regions);}finally{session.dispose();}}
 status.textContent='stored visual completed · 最終繪字，沿用已存 OCR／譯文，零外部翻譯請求';
}
document.querySelector('#visual')!.addEventListener('click',()=>{void locked(visual);});
const stored=document.querySelector('#stored')??document.body.insertBefore(Object.assign(document.createElement('button'),{id:'stored',textContent:'沿用已存文字檢查最終繪字'}),status);
stored.addEventListener('click',()=>{void locked(storedVisual);});
document.querySelector('#benchmark')!.addEventListener('click',()=>{void locked(benchmark);});
document.querySelector('#native')!.addEventListener('click',()=>{void locked(native);});
document.querySelector('#finish')!.addEventListener('click',()=>{worker.terminate();void fetch('/finish',{method:'POST'}).then(()=>status.textContent='server closed');});
