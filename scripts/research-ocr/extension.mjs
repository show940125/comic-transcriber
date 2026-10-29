// Actual extension-origin offscreen -> production Worker acceptance, isolated profiles.
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir,cp,copyFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {launchTestContext,testProfile,freshWorker} from '../harness.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=path.join(root,'artifacts/research-ocr');
const args=process.argv.slice(2),uiOnly=args.includes('--ui-only'),final=args.includes('--final'),extension=path.join(out,uiOnly?'test-extension-ui':final?'test-extension-final':'test-extension');
const data=JSON.parse(await readFile(path.join(out,'dataset.json'),'utf8')),lock=JSON.parse(await readFile(path.join(root,'src/model-lock.json'),'utf8'));
await mkdir(extension,{recursive:true});await cp(path.join(root,'.output/chrome-mv3'),extension,{recursive:true});
for(const model of lock.vision)for(const file of model.files){const folder=path.join(extension,'models',model.id);await mkdir(folder,{recursive:true});await copyFile(path.join(root,'.cache/models',model.id,file.name),path.join(folder,file.name));}
const cases=uiOnly||final?[['chromium',4,'sample'],['msedge',4,'sample']]:[['chromium',4,'all'],['msedge',4,'all'],['chromium',1,'sample'],['msedge',1,'sample']];
for(const [channel,threads,selection] of cases){
 const name=`extension-${channel}-t${threads}${uiOnly?'-ui':final?'-final':''}`,report={name,status:'running',channel,threads,selection,startedAt:new Date().toISOString(),runs:[],checks:[],errors:[],externalRequests:[]};let context,page;
 const save=()=>writeFile(path.join(out,'combo',name+'.json'),JSON.stringify(report,null,2));
 try{
  context=await launchTestContext(chromium,await testProfile(root,'e2e'),{channel,headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1500,height:1000}});
  const worker=await freshWorker(context),id=worker.url().split('/')[2];page=await context.newPage();page.setDefaultTimeout(90000);
  await context.route(/^https?:/,async route=>{report.externalRequests.push(route.request().url());await route.abort();});
  await page.goto(`chrome-extension://${id}/reader.html`);page.on('pageerror',e=>report.errors.push(String(e)));
  report.manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));report.userAgent=await page.evaluate(()=>navigator.userAgent);await page.evaluate(threads=>chrome.storage.local.set({settings:{wasmThreads:threads,ocrProfile:'int8'}}),threads);
  const call=async(row,profile)=>{
   const bytes=(await readFile(path.join(out,row.crop))).toString('base64'),rect={id:row.id,x:0,y:0,width:row.box.width,height:row.box.height,order:0,source:'',translation:'',score:1,warnings:[],kind:'bubble',render:'auto'};
   const began=performance.now();const response=await page.evaluate(({bytes,rect,profile})=>chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'ocr',profile,provider:'wasm',image:bytes,mime:'image/png',regions:[rect]}}),{bytes,rect,profile});assert(response.ok,response.error);
   const r=response.result[0];assert.equal(r.id,row.id);assert.equal(r.ocr.profile,profile);return {id:r.id,source:r.source,ocr:r.ocr,warnings:r.warnings,ms:performance.now()-began};
  };
  if(!uiOnly){
   for(const profile of ['int8','fp32']){
    const rows=selection==='all'?data.records:data.records.filter(r=>data.sample.includes(r.id)),run={profile,status:'running',results:[],performance:[]};report.runs.push(run);
    for(const row of rows){run.results.push(await call(row,profile));if(run.results.length%40===0){await save();console.log(`${name}/${profile}: ${run.results.length}/${rows.length}`);}}
    for(let n=0;n<3;n++){const sample=[];for(const rid of data.sample)sample.push(await call(data.records.find(r=>r.id===rid),profile));run.performance.push({run:n+1,totalMs:sample.reduce((sum,r)=>sum+r.ms,0),rows:sample});await save();}
    const info=await page.evaluate(()=>chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'runtime-info'}}));run.runtime=info.result;assert.equal(run.runtime.effectiveThreads,threads);if(threads>1)assert(run.runtime.spawnedPthreads>=threads-1);
    const expected=Object.values(lock.ocrProfiles[profile]).filter(v=>v&&typeof v==='object'&&v.file.endsWith('.onnx')).map(v=>`${v.model}/${v.file}/wasm`).sort();assert.deepEqual([...run.runtime.modelFiles].sort(),expected);assert.equal(run.runtime.models,expected.length);
    run.status='complete';await save();
   }
  }
  if(!uiOnly){
   report.switchChecks=[];
   for(const profile of ['int8','fp32','int8']){await call(data.records.find(r=>r.dataset==='synthetic'),profile);const state=await page.evaluate(()=>chrome.runtime.sendMessage({channel:'engine',id:crypto.randomUUID(),request:{op:'runtime-info'}}));assert.equal(state.result.ocrProfile,profile);assert.equal(state.result.models,profile==='int8'?2:3);report.switchChecks.push(state.result);}
   const browser=context.browser();if(browser){const cdp=await browser.newBrowserCDPSession();const processes=await cdp.send('SystemInfo.getProcessInfo');report.processMemory=JSON.parse(execFileSync('python',[path.join(root,'scripts/research-ocr/process_memory.py'),JSON.stringify(processes.processInfo)],{encoding:'utf8'}));await cdp.detach();}
  }
  if(threads===4){
   report.currentCheck='fixture load';
   const row=data.records.find(r=>r.dataset==='synthetic'),buffer=await readFile(path.join(out,row.crop)),hash=createHash('sha256').update(buffer).digest('hex');
   await page.locator('input[type=file][accept="image/*"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer});await page.locator('canvas').waitFor();
   const first={id:'review-a',x:0,y:0,width:row.box.width,height:row.box.height,order:0,source:'舊原文',translation:'保留譯文',initialTranslation:'初譯',score:.8,warnings:[],kind:'bubble',render:'auto'},other={...first,id:'review-b',x:1,y:1,width:8,height:8,order:1,source:'其他框',translation:'其他譯文'};
   const correction={schema:1,hash,width:row.box.width,height:row.box.height,regions:[first,other]};
   report.currentCheck='correction import';
   await page.getByLabel('載入校正 JSON').setInputFiles({name:'correction.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(correction))});await page.waitForFunction(()=>document.body.innerText.includes('校正已載入'));
   report.currentCheck='single-box comparison';
   await page.getByRole('button',{name:'重新辨識此框',exact:true}).click();await page.waitForFunction(()=>document.body.innerText.includes('候選已保留'));
   assert.equal(await page.getByLabel('日文原文',{exact:true}).inputValue(),'舊原文');assert.equal(await page.getByLabel('繁中譯文',{exact:true}).inputValue(),'保留譯文');
   await page.getByRole('button',{name:'套用候選 2',exact:true}).click();assert.notEqual(await page.getByLabel('日文原文',{exact:true}).inputValue(),'舊原文');assert.equal(await page.getByLabel('繁中譯文',{exact:true}).inputValue(),'');
   report.checks.push('single-box candidate preserves original until selected; selection invalidates affected translation');
   report.currentCheck='other-profile comparison';
   await page.getByRole('button',{name:'使用另一模式比較',exact:true}).click();await page.waitForFunction(()=>document.querySelector('aside')?.textContent.includes('候選 2 · fp32'));
   await page.getByRole('button',{name:'拆框',exact:true}).click();const box=await page.locator('.image-wrap').boundingBox();await page.mouse.move(box.x+box.width*.45,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.45,box.y+box.height*.8);await page.mouse.up();await page.getByRole('button',{name:'套用拆框',exact:true}).click();assert.equal(await page.getByLabel('選擇文字框').locator('option').count(),4);
   await page.getByRole('button',{name:'撤銷拆框',exact:true}).click();assert.equal(await page.getByLabel('選擇文字框').locator('option').count(),3);
   await page.getByLabel('選擇文字框').selectOption('review-b');assert.equal(await page.getByLabel('繁中譯文',{exact:true}).inputValue(),'其他譯文');
   report.checks.push('fp32 comparison, drawn split, undo and other-region translation preservation');
   if(uiOnly||final){
    report.currentCheck='explicit legacy roundtrip';
    const legacyModelKey=JSON.stringify(['private-reader-v1',JSON.stringify(['pipeline-3-ocr-review','google-web'])]),key=`page:${hash}:${legacyModelKey}`;
    await page.evaluate(async({key,pageData})=>{const {pageKeys=[]}=await chrome.storage.local.get('pageKeys');await chrome.storage.local.set({[key]:pageData,pageKeys:[key,...pageKeys.filter(k=>k!==key)]});},{key,pageData:{...correction,modelKey:legacyModelKey,title:'',chapter:'',glossary:'',summary:''}});
    await page.locator('input[type=file][accept="image/*"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer});await page.getByText('找到 1 份舊版結果（legacy）',{exact:true}).click();await page.getByRole('button',{name:'載入舊結果 1',exact:true}).click();await page.getByLabel('選擇文字框').selectOption('review-a');
    assert.equal(await page.getByLabel('日文原文',{exact:true}).inputValue(),'舊原文');
    await page.getByRole('button',{name:'重新辨識此框',exact:true}).click();await page.waitForFunction(()=>document.body.innerText.includes('候選已保留'));
    const legacySaved=(await page.evaluate(key=>chrome.storage.local.get(key),key))[key];assert.equal(legacySaved.regions[0].source,'舊原文');const candidateAt=legacySaved.regions[0].ocrCandidates[1].at;
    await page.getByRole('button',{name:'套用候選 2',exact:true}).click();
    await page.evaluate(async({hash,key,candidateAt})=>{const start=performance.now();while(performance.now()-start<10000){const all=await chrome.storage.local.get(null);if(Object.entries(all).some(([k,v])=>k.startsWith(`page:${hash}:`)&&k!==key&&v.regions?.[0]?.ocr?.at===candidateAt))return;await new Promise(r=>setTimeout(r,50));}throw Error('adopted OCR did not reach separate profile cache');},{hash,key,candidateAt});
    const preserved=await page.evaluate(key=>chrome.storage.local.get(key),key);assert.equal(preserved[key].regions[0].source,'舊原文');report.checks.push('explicit private legacy load keeps old identity and original while new OCR is adopted separately');
   }
   await page.screenshot({path:path.join(out,'combo',name+'-ui.png')});
   report.currentCheck='progress-synchronized cancellation';
   const bytes=buffer.toString('base64');const cancelled=await page.evaluate(async({bytes,region})=>{
    const id=crypto.randomUUID();let observed=false;
    const listener=message=>{if(message.channel==='progress'&&message.id===id&&!observed){observed=true;void chrome.runtime.sendMessage({channel:'cancel',id});}};
    chrome.runtime.onMessage.addListener(listener);
    try{const response=await chrome.runtime.sendMessage({channel:'engine',id,request:{op:'ocr',profile:'int8',provider:'wasm',image:bytes,mime:'image/png',regions:Array.from({length:20},(_,i)=>({...region,id:String(i)}))}});return {response,observed};}
    finally{chrome.runtime.onMessage.removeListener(listener);}
   },{bytes,region:first});assert(cancelled.observed);assert.equal(cancelled.response.ok,false);report.cancellation=cancelled;report.checks.push('progress-synchronized real OCR cancellation settles with failure');
   await call(row,'int8');report.checks.push('OCR successfully resumes after cancellation');
   report.beforeIdle=await page.evaluate(()=>chrome.runtime.sendMessage({channel:'runtime-status'}));assert.equal(report.beforeIdle.result.worker,true);
   report.idleElapsedMs=await page.evaluate(async()=>{const start=performance.now();while(performance.now()-start<90000){const r=await chrome.runtime.sendMessage({channel:'runtime-status'});if(r.result?.worker===false)return performance.now()-start;await new Promise(resolve=>setTimeout(resolve,2000));}throw Error('idle release did not occur');});assert(report.idleElapsedMs>=55000,'runtime released before expected idle interval');report.checks.push('actual 60-second idle release');
  }
  assert.equal(report.errors.length,0);assert.equal(report.externalRequests.length,0);report.status='passed';
 }catch(error){report.status='failed';report.error=String(error);report.errorStack=error.stack;if(page){await page.screenshot({path:path.join(out,'combo',name+'-failure.png')}).catch(()=>{});report.failureText=await page.locator('body').innerText().catch(()=>'');}console.error(name,report.error);process.exitCode=1;}
 finally{report.completedAt=new Date().toISOString();await context?.close();await save();}
}
