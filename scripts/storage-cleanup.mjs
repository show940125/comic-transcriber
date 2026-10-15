import {readdir,readFile,rm,mkdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exists,safePath,treeSize,sha256,writeJson,browserProcesses,profileInUse,removeProfile,profilePattern,releasePattern,retainedReleases,newestReleases} from './storage-tools.mjs';

export async function cleanupProject(root,{apply=false,inspect=browserProcesses}={}){
  root=path.resolve(root);
  const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  if(metadata.name!=='comic-transcriber')throw Error('Unexpected project root');
  const report={schema:1,mode:apply?'apply':'preview',started:new Date().toISOString(),before:await treeSize(root),retained:[],items:[]};
  const artifacts=await safePath(root,'artifacts');
  let pinned;
  const installed=await safePath(root,'artifacts/chrome-translator-installed.json');
  if(await exists(installed)){
    const data=JSON.parse(await readFile(installed,'utf8'));
    if(!data.profile)throw Error('Translator report has no profile; refuse profile cleanup');
    pinned=await safePath(root,path.relative(root,data.profile));
    if(path.dirname(pinned)!==artifacts||!profilePattern.test(path.basename(pinned)))throw Error('Invalid retained translator profile');
    report.retained.push(path.relative(root,pinned));
  }
  let processes,inspectionError;
  try{processes=await inspect();}catch(error){inspectionError=String(error);}
  async function add(relative,kind,reason){
    const target=await safePath(root,relative);if(!await exists(target))return;
    const size=await treeSize(target);report.items.push({path:relative,kind,reason,...size,status:'candidate'});
  }
  if(await exists(artifacts))for(const name of await readdir(artifacts)){
    if(!profilePattern.test(name))continue;
    const target=await safePath(root,path.join('artifacts',name));if(target===pinned)continue;
    await add(path.join('artifacts',name),'profile','過期隔離測試設定檔；模型與報告另行保留');
    const item=report.items.at(-1);
    if(inspectionError||profileInUse(target,processes))Object.assign(item,{status:'skipped',detail:inspectionError??'browser-in-use'});
  }
  const archive=await safePath(root,'artifacts/release-archive');
  const dist=await safePath(root,'dist'),published=await exists(dist)?newestReleases(await readdir(dist)).slice(0,2):[];
  if(await exists(archive))for(const date of await readdir(archive)){
    if(!/^\d{8}-\d{6}$/.test(date))continue;
    const directory=await safePath(root,path.join('artifacts/release-archive',date));
    if(!(await lstat(directory)).isDirectory())continue;
    for(const name of await readdir(directory))if(releasePattern.test(name)){
      const relative=path.join('artifacts/release-archive',date,name);
      if(newestReleases([...new Set([...published,name])]).indexOf(name)<2){report.retained.push(relative);continue;}
      await add(relative,'archive','舊版發布包；保留原始 manifest 與 SHA-256');
    }
  }
  for(const name of ['001bj.zip','volume-01.pdf'])await add(path.join('.cache/corpus',name),'corpus','可重新下載的原始語料；已擷取圖片、授權及雜湊紀錄保留');
  // Verify both retained releases before deleting any historic distribution ZIP.
  if(apply){
    report.retainedReleases=await retainedReleases(root);
    if(report.items.some(x=>x.kind==='archive')&&report.retainedReleases.length!==2)throw Error('Two verified retained releases are required before archive cleanup');
    const output=await safePath(root,'artifacts/storage-cleanup');await mkdir(output,{recursive:true});
    const stamp=report.started.replace(/[:.]/g,'-'),file=path.join(output,stamp+'.json');
    report.reportPath=path.relative(root,file);
    await writeJson(file,report); // Persist the exact deletion list before removing data.
    for(const item of report.items){
      if(item.status!=='candidate')continue;
      try{
        const target=await safePath(root,item.path);await treeSize(target);
        if(item.kind==='profile')Object.assign(item,await removeProfile(root,item.path,{inspect}));
        else{item.sha256=await sha256(target);await writeJson(file,report);await rm(target);item.status='deleted';}
      }catch(error){item.status='failed';item.detail=String(error);}
      await writeJson(file,report);
    }
    report.after=await treeSize(root);report.freedBytes=report.before.bytes-report.after.bytes;
    report.finished=new Date().toISOString();await writeJson(file,report);
  }
  report.candidateBytes=report.items.filter(item=>item.status==='candidate').reduce((sum,item)=>sum+item.bytes,0);
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);if(args.some(arg=>arg!=='--apply'))throw Error('Usage: node scripts/storage-cleanup.mjs [--apply]');
  const root=fileURLToPath(new URL('../',import.meta.url)),report=await cleanupProject(root,{apply:args.includes('--apply')});
  console.log(JSON.stringify(report,null,2));if(report.items.some(item=>item.status==='failed'))process.exitCode=1;
}
