import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import {exists,safePath,removeProfile,profilePattern,writeJson} from './storage-tools.mjs';
// A fresh isolated profile avoids Chromium retaining an older same-version MV3 script.
export async function testProfile(root, label) {
  if(!/^[a-z][a-z0-9-]*$/.test(label)||!profilePattern.test(label+'-profile-test'))throw Error('Unknown test profile label');
  const prefix=await safePath(root,path.join('artifacts',label+'-profile-'));
  return await mkdtemp(prefix);
}
export async function translatorProfile(root){
  try{
    const report=JSON.parse(await readFile(path.join(root,'artifacts/chrome-translator-installed.json'),'utf8'));
    if(report.profile){const profile=await safePath(root,path.relative(root,report.profile));if(path.dirname(profile)!==path.join(path.resolve(root),'artifacts')||!profilePattern.test(path.basename(profile)))throw Error('Invalid translator profile');if(await exists(profile))return profile;}
  }catch(e){if(e.code!=='ENOENT')throw e;}
  return testProfile(root,'translator-components');
}
// Only close() completion authorizes removal; a live or locked browser stays intact.
export async function launchTestContext(browserType,profile,options,{retain=false,inspect}={}){
  const root=path.dirname(path.dirname(profile)),relative=path.relative(root,profile);
  await safePath(root,relative);
  const record=async(phase,result)=>writeJson(await safePath(root,path.join('artifacts/test-profile-lifecycle',path.basename(profile)+'.json')),{profile:relative,phase,...result,recordedAt:new Date().toISOString()});
  const cleanup=async phase=>{
    if(typeof retain==='function'?retain():retain){await record(phase,{status:'retained'});return;}
    try{const result=await removeProfile(root,relative,{inspect});await record(phase,result);if(result.status!=='deleted')console.warn('Test profile retained:',relative,result.reason);}
    catch(error){await record(phase,{status:'deferred',error:String(error)});console.warn('Test profile cleanup deferred:',relative,String(error));}
  };
  let context;
  try{context=await browserType.launchPersistentContext(profile,options);}
  catch(error){await cleanup('launch-failed');throw error;}
  const close=context.close.bind(context);let closing;
  context.close=(...args)=>closing??=(async()=>{
    try{await close(...args);}catch(error){await record('close-failed',{status:'retained'});throw error;}
    await cleanup('closed');
  })();
  return context;
}
export async function freshWorker(context) {
  const ours=async worker=>await worker.evaluate(()=>chrome.runtime.getManifest().name==='墨譯 Comic Transcriber').catch(()=>false);
  for(const worker of context.serviceWorkers())if(await ours(worker))return worker;
  return await context.waitForEvent('serviceworker',{predicate:ours});
}
