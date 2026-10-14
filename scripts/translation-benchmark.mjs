import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshWorker, testProfile } from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const corpus=JSON.parse(await readFile(path.join(root,'artifacts/corpus/manifest.json'),'utf8'));
const lock=JSON.parse(await readFile(path.join(root,'src/model-lock.json'),'utf8'));
const output={type:'actual-browser-WebLLM',humanReview:'pending',realMangaAcceptance:false,models:[],started:new Date().toISOString()};
const count=Number(process.env.BENCHMARK_PAGES??30);
const extension=path.join(root,'.output/chrome-mv3');
await mkdir(path.join(root,'artifacts/translation-profile'),{recursive:true});
const profile=await testProfile(root,'translation');output.profile=path.basename(profile);
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
try{
  const worker=await freshWorker(context);
  const id=worker.url().split('/')[2],page=await context.newPage();
  await page.goto(`chrome-extension://${id}/reader.html`);await page.waitForLoadState('networkidle');
  const gpu=await page.evaluate(async()=>{const r=await chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'probe'}});return r.result;});output.gpu=gpu;
  await page.exposeFunction('recordProgress',d=>{if(d.stage==='loading')console.log(d.message);});
  await page.evaluate(()=>chrome.runtime.onMessage.addListener(m=>{if(m.channel==='progress')void window.recordProgress(m.diagnostic);}));
  for(const size of ['0.8B','2B']){
    const modelId=`Qwen3.5-${size}-q4f${gpu.f16?'16':'32'}_1-MLC`,rows=[];
    const spec=lock.llm.find(m=>m.model_id===modelId);
    const result={modelId,revision:spec.revision,pages:rows,failures:[],humanScore:null};output.models.push(result);
    for(const source of corpus.pages.slice(0,count)){
      const settings={backend:'webllm',model:size==='2B'?'2b':'0.8b',endpoint:'http://127.0.0.1:8080/v1',localModel:'',localOcr:false,ocrEndpoint:'http://127.0.0.1:8766',auto:false,title:'原創測試對白',chapter:'測試',glossary:'',priorSummary:''};
      const started=performance.now();
      const response=await page.evaluate(async({regions,settings,modelId})=>await chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'translate',regions,settings,modelId}}),{regions:source.regions,settings,modelId});
      const seconds=(performance.now()-started)/1000;
      if(!response.ok){result.failures.push({file:source.file,error:response.error,modelOutput:response.modelOutput,seconds});console.log(`${modelId} failed: ${response.error}`);if(response.modelOutput)console.log('Model output:',response.modelOutput);break;}
      rows.push({file:source.file,category:source.category,seconds,regions:response.result.map((r,i)=>({id:r.id,source:r.source,translation:r.translation,reference:source.regions[i].reference}))});
      await writeFile(path.join(root,'artifacts/translation-benchmark.partial.json'),JSON.stringify(output,null,2));
      console.log(`${modelId}: ${source.file} ${seconds.toFixed(2)}s`);
    }
    if(rows.length){const times=rows.map(r=>r.seconds).sort((a,b)=>a-b);result.metrics={completedPages:rows.length,p50_s:times[Math.floor(times.length/2)],p95_s:times[Math.min(times.length-1,Math.floor(times.length*.95))],firstPageIncludingInitialization_s:rows[0].seconds};}
  }
  output.status=output.models.every(m=>m.pages.length===count)?'executed-pending-human-quality-review':'incomplete';
  if(output.status==='incomplete')process.exitCode=1;
  // Verify warm cached WebLLM operation with all HTTP(S) requests blocked.
  if(output.models.some(m=>m.pages.length)){
    await context.route('https://**/*',r=>r.abort());
    const selected=output.models.filter(m=>m.pages.length).at(-1);
    await context.setOffline(true);
    const response=await page.evaluate(async({regions,modelId})=>{const settings={backend:'webllm',model:'2b',title:'',chapter:'',glossary:'',priorSummary:'',localModel:'',endpoint:'http://127.0.0.1:8080/v1'};return chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'translate',regions,settings,modelId}});},{regions:corpus.pages[0].regions.slice(0,1),modelId:selected.modelId});output.warmOffline={ok:response.ok,error:response.error,result:response.result};
  }
}catch(error){output.error=String(error);output.status='failed';process.exitCode=1;}
finally{await context.close();output.finished=new Date().toISOString();await writeFile(path.join(root,'artifacts/translation-benchmark.json'),JSON.stringify(output,null,2));console.log(JSON.stringify({status:output.status,models:output.models.map(m=>({model:m.modelId,metrics:m.metrics,failures:m.failures})),error:output.error}));}
