import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
// A fresh isolated profile avoids Chromium retaining an older same-version MV3 script.
export async function testProfile(root, label) { return await mkdtemp(path.join(root,'artifacts',label+'-profile-')); }
export async function freshWorker(context) {
  const ours=async worker=>await worker.evaluate(()=>chrome.runtime.getManifest().name==='墨譯 Comic Transcriber').catch(()=>false);
  for(const worker of context.serviceWorkers())if(await ours(worker))return worker;
  return await context.waitForEvent('serviceworker',{predicate:ours});
}
