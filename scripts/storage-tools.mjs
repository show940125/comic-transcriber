import {lstat, readdir, readFile, writeFile, mkdir, rm, rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const execute=promisify(execFile);
export const releasePattern=/^comic-transcriber-(\d+)\.(\d+)\.(\d+)-offline-vision\.zip$/;
export const profilePattern=/^(?:e2e|translation|cdn-regression|pipeline-(?:edge|chrome)|chapter-e2e|no-gpu|translator-components|google-free|native-browser|fallback|handoff|edge|permission|local-ocr-proxy|chrome-translator)-profile(?:-[A-Za-z0-9_-]+)?$/;
export async function exists(file){try{await lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function safePath(root, relative){
  root=path.resolve(root);
  const target=path.resolve(root,relative),rel=path.relative(root,target);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Target must stay inside project: '+relative);
  let current=root;
  for(const part of ['',...rel.split(path.sep)]){
    current=part?path.join(current,part):current;
    try{if((await lstat(current)).isSymbolicLink())throw Error('Link/reparse target refused: '+current);}
    catch(e){if(e.code==='ENOENT')break;throw e;}
  }
  return target;
}
export async function treeSize(target){
  const info=await lstat(target);
  if(info.isSymbolicLink())throw Error('Link/reparse target refused: '+target);
  if(info.isFile())return {bytes:info.size,files:1};
  let bytes=0,files=0;
  for(const child of await readdir(target)){const size=await treeSize(path.join(target,child));bytes+=size.bytes;files+=size.files;}
  return {bytes,files};
}
export async function sha256(file){const hash=createHash('sha256');for await(const data of createReadStream(file))hash.update(data);return hash.digest('hex');}
export async function writeJson(file,value){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n');await rename(temp,file);}
export async function browserProcesses(){
  if(process.platform!=='win32')throw Error('Browser ownership inspection requires Windows PowerShell');
  // CIM can return a terminating process with no command line. Refresh just
  // those PIDs; an inaccessible live browser still makes cleanup fail closed.
  const query="$ErrorActionPreference='Stop'; $rows=@(foreach($p in (Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('chrome.exe','msedge.exe','chromium.exe') })) { if(-not $p.CommandLine) { $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ProcessId); if(-not $p) { continue }; if(-not $p.CommandLine -and -not (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue)) { continue } }; $p | Select-Object ProcessId,CommandLine }); ConvertTo-Json -InputObject $rows -Compress";
  const {stdout}=await execute('pwsh',['-NoProfile','-Command',query],{maxBuffer:8*1024*1024});
  const rows=JSON.parse(stdout||'[]');const list=Array.isArray(rows)?rows:[rows];
  if(list.some(row=>!row.CommandLine))throw Error('Cannot inspect all browser command lines');
  return list;
}
export function profileInUse(profile,processes){
  const key=path.resolve(profile).replaceAll('/','\\').toLowerCase();
  return processes.some(row=>String(row.CommandLine).replaceAll('/','\\').toLowerCase().includes(key));
}
export async function removeProfile(root,relative,{inspect=browserProcesses}={}){
  const target=await safePath(root,relative);
  if(path.dirname(target)!==path.join(path.resolve(root),'artifacts')||!profilePattern.test(path.basename(target)))throw Error('Not an approved test profile');
  try{
    const report=JSON.parse(await readFile(await safePath(root,'artifacts/chrome-translator-installed.json'),'utf8'));
    if(!report.profile)throw Error('Retained translator profile is unknown');
    const pinned=await safePath(root,path.relative(root,report.profile));
    if(target===pinned)return {status:'skipped',reason:'retained-translator-profile'};
  }catch(e){if(e.code!=='ENOENT')throw e;}
  if(profileInUse(target,await inspect()))return {status:'skipped',reason:'browser-in-use'};
  await treeSize(target); // Refuse links anywhere below a recursive removal target.
  await rm(target,{recursive:true});
  return {status:'deleted'};
}
export function newestReleases(names){return names.filter(name=>releasePattern.test(name)).sort((a,b)=>{
  const av=a.match(releasePattern).slice(1).map(Number),bv=b.match(releasePattern).slice(1).map(Number);
  for(let i=0;i<3;i++)if(av[i]!==bv[i])return bv[i]-av[i];return 0;
});}
export async function retainedReleases(root){
  const dist=await safePath(root,'dist');
  if(!await exists(dist))return [];
  const names=newestReleases(await readdir(dist)).slice(0,2);
  let index='';try{index=await readFile(path.join(dist,'SHA256.txt'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  const results=[];
  for(const name of names){const file=await safePath(root,path.join('dist',name));const digest=await sha256(file);
    const expected=index.split(/\r?\n/).find(line=>line.endsWith('  '+name))?.slice(0,64);
    if(!expected||digest!==expected)throw Error('Retained release checksum missing or mismatched: '+name);
    results.push({name,sha256:digest,bytes:(await lstat(file)).size});
  }
  return results;
}
export async function pruneReleases(root){
  const dist=await safePath(root,'dist'),names=newestReleases(await readdir(dist));
  // Caller must validate and publish the new ZIP + index before pruning.
  await retainedReleases(root);
  const historyFile=await safePath(root,'artifacts/release-history.json');
  let history={schema:1,releases:[]};if(await exists(historyFile))history=JSON.parse(await readFile(historyFile,'utf8'));
  for(const name of names.slice(2)){
    const file=await safePath(root,path.join('dist',name));const entry={name,sha256:await sha256(file),bytes:(await lstat(file)).size,status:'pending-delete',recordedAt:new Date().toISOString()};
    history.releases.push(entry);await writeJson(historyFile,history);
    await rm(file);entry.status='deleted';await writeJson(historyFile,history);
  }
  return names.slice(0,2);
}
