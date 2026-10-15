import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {cleanupProject} from '../scripts/storage-cleanup.mjs';
import {safePath,exists,sha256,removeProfile,newestReleases,pruneReleases,treeSize} from '../scripts/storage-tools.mjs';
import {launchTestContext,testProfile,translatorProfile} from '../scripts/harness.mjs';
import {zipSync,strToU8} from 'fflate';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'comic-storage-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const put=async(name,data='fixture')=>{const p=path.join(root,name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,data);return p;};
  await put('package.json',JSON.stringify({name:'comic-transcriber'}));await mkdir(path.join(root,'artifacts'));
  return {root,put};
}
async function releases(f,versions=['0.1.11','0.1.10']){
  const lines=[];for(const version of versions){const name=`comic-transcriber-${version}-offline-vision.zip`,file=await f.put('dist/'+name,version);lines.push(await sha256(file)+'  '+name);}
  await f.put('dist/SHA256.txt',lines.join('\n')+'\n');
}
test('storage preview is read-only and excludes language packs, models and corrections',async t=>{
  const f=await fixture(t),pin=await testProfile(f.root,'translator-components');
  await f.put('artifacts/chrome-translator-installed.json',JSON.stringify({profile:pin}));
  await f.put('artifacts/e2e-profile-old/Default/model',Buffer.alloc(19));
  await f.put('.cache/models/encoder.onnx');await f.put('artifacts/live-chapter/correction.json');await f.put('.cache/corpus/001bj.zip',Buffer.alloc(7));
  const before=await treeSize(f.root),report=await cleanupProject(f.root,{inspect:async()=>[]});
  assert.deepEqual(report.items.map(x=>x.kind),['profile','corpus']);assert.equal(report.candidateBytes,26);assert.deepEqual(await treeSize(f.root),before);
  assert.equal(await exists(pin),true);assert.equal(await exists(path.join(f.root,'artifacts/storage-cleanup')),false);
});
test('apply deletes only approved generated data and retains archive manifest',async t=>{
  const f=await fixture(t);await releases(f);
  await f.put('artifacts/e2e-profile-old/Default/cache');await f.put('.cache/corpus/volume-01.pdf');
  await f.put('artifacts/release-archive/20261015-151202/comic-transcriber-0.1.9-offline-vision.zip');
  await f.put('artifacts/release-archive/20261015-151202/manifest.json','{"historic":true}');
  await f.put('artifacts/real-corpus/pages/page.png');await f.put('artifacts/manual-profile/precious');
  const report=await cleanupProject(f.root,{apply:true,inspect:async()=>[]});
  assert.equal(report.items.filter(x=>x.status==='deleted').length,3);
  assert(await exists(path.join(f.root,'artifacts/release-archive/20261015-151202/manifest.json')));
  assert(await exists(path.join(f.root,'artifacts/real-corpus/pages/page.png')));assert(await exists(path.join(f.root,'artifacts/manual-profile/precious')));
  assert(await exists(path.join(f.root,report.reportPath)));
});
test('active profile and unavailable process inspection both prevent removal',async t=>{
  const f=await fixture(t);const profile=await testProfile(f.root,'e2e');
  const result=await removeProfile(f.root,path.relative(f.root,profile),{inspect:async()=>[{CommandLine:`chrome.exe --user-data-dir="${profile}"`}]});
  assert.equal(result.status,'skipped');assert(await exists(profile));
  const report=await cleanupProject(f.root,{apply:true,inspect:async()=>{throw Error('access denied');}});
  assert.equal(report.items[0].status,'skipped');assert(await exists(profile));
});
test('pinned translator profile is protected even if a test fails',async t=>{
  const f=await fixture(t);const pin=await testProfile(f.root,'translator-components');await f.put('artifacts/chrome-translator-installed.json',JSON.stringify({profile:pin}));
  assert.equal((await removeProfile(f.root,path.relative(f.root,pin),{inspect:async()=>[]})).reason,'retained-translator-profile');
  assert.equal(await translatorProfile(f.root),pin);
});
test('path escapes, root deletion and nested junctions are rejected',async t=>{
  const f=await fixture(t),outside=await mkdtemp(path.join(os.tmpdir(),'comic-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await assert.rejects(safePath(f.root,'../elsewhere'));await assert.rejects(safePath(f.root,'.'));
  const profile=await testProfile(f.root,'e2e');await symlink(outside,path.join(profile,'linked'),'junction');
  await assert.rejects(removeProfile(f.root,path.relative(f.root,profile),{inspect:async()=>[]}),/Link\/reparse/);
  assert(await exists(outside));
});
test('unknown roots and corrupt release checksums abort before archive deletion',async t=>{
  const f=await fixture(t);await releases(f);await f.put('artifacts/release-archive/20261015-151202/comic-transcriber-0.1.9-offline-vision.zip');
  await f.put('dist/comic-transcriber-0.1.11-offline-vision.zip','corrupt');
  await assert.rejects(cleanupProject(f.root,{apply:true,inspect:async()=>[]}),/checksum/);
  assert(await exists(path.join(f.root,'artifacts/release-archive/20261015-151202/comic-transcriber-0.1.9-offline-vision.zip')));
  await f.put('package.json','{"name":"other-project"}');await assert.rejects(cleanupProject(f.root,{inspect:async()=>[]}),/Unexpected project/);
});
test('numeric release retention preserves two newest with deletion history',async t=>{
  const f=await fixture(t);await releases(f,['0.1.9','0.1.10','0.1.11']);
  assert.deepEqual(newestReleases(['comic-transcriber-0.1.9-offline-vision.zip','comic-transcriber-0.1.10-offline-vision.zip']),['comic-transcriber-0.1.10-offline-vision.zip','comic-transcriber-0.1.9-offline-vision.zip']);
  await pruneReleases(f.root);assert.equal((await readdir(path.join(f.root,'dist'))).filter(x=>x.endsWith('.zip')).length,2);
  const history=JSON.parse(await readFile(path.join(f.root,'artifacts/release-history.json'),'utf8'));assert.equal(history.releases[0].status,'deleted');assert.equal(history.releases[0].sha256.length,64);
});
test('release CRC verifier rejects corrupt archives and wrong manifest versions',async t=>{
  const f=await fixture(t),script=fileURLToPath(new URL('../scripts/verify-release.py',import.meta.url));
  const files=Object.fromEntries(['LICENSE','NOTICE.md','offscreen.html','reader.html'].map(name=>[name,strToU8('fixture')]));
  files['manifest.json']=strToU8('{"version":"0.1.11"}');
  const file=await f.put('release.zip',zipSync(files));
  execFileSync('python',[script,file,'0.1.11'],{stdio:'pipe'});
  assert.throws(()=>execFileSync('python',[script,file,'0.1.10'],{stdio:'pipe'}));
  await writeFile(file,'broken archive');assert.throws(()=>execFileSync('python',[script,file,'0.1.11'],{stdio:'pipe'}));
});
for(const outcome of ['success','test-failure','launch-failure','close-failure'])test(`test profile lifecycle: ${outcome}`,async t=>{
  const f=await fixture(t),profile=await testProfile(f.root,'e2e');let closed=false;
  const browser={launchPersistentContext:async()=>{if(outcome==='launch-failure')throw Error('launch failed');return {close:async()=>{if(outcome==='close-failure')throw Error('close failed');closed=true;}};}};
  if(outcome==='launch-failure')await assert.rejects(launchTestContext(browser,profile,{}, {inspect:async()=>[]}),/launch failed/);
  else{
    const context=await launchTestContext(browser,profile,{}, {inspect:async()=>[]});
    if(outcome==='test-failure'){try{throw Error('test failed');}catch{}finally{await context.close();}}
    else if(outcome==='close-failure')await assert.rejects(context.close(),/close failed/);
    else{await context.close();await context.close();}
  }
  assert.equal(await exists(profile),outcome==='close-failure');if(outcome==='success')assert(closed);
});
