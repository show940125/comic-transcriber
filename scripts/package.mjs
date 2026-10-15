import { mkdir, readFile, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {newestReleases,sha256,pruneReleases,safePath,exists,retainedReleases} from './storage-tools.mjs';
const root=new URL('../',import.meta.url),directory=new URL('.output/chrome-mv3/',root),files={};
const metadata=JSON.parse(await readFile(new URL('package.json',root),'utf8')),filename=`comic-transcriber-${metadata.version}-offline-vision.zip`;
if(await exists(fileURLToPath(new URL('dist/',root))))await retainedReleases(fileURLToPath(root));
async function walk(dir,prefix=''){for(const name of await readdir(dir)){const file=new URL(name,dir);if((await stat(file)).isDirectory())await walk(new URL(name+'/',dir),prefix+name+'/');else files[prefix+name]=new Uint8Array(await readFile(file));}}
await walk(directory);files['LICENSE']=strToU8(await readFile(new URL('LICENSE',root),'utf8'));files['NOTICE.md']=strToU8(await readFile(new URL('NOTICE.md',root),'utf8'));
await safePath(fileURLToPath(root),'dist/'+filename);
await mkdir(new URL('dist/',root),{recursive:true});const zip=zipSync(files,{level:6});
const target=new URL(`dist/${filename}`,root),partial=new URL(`dist/${filename}.partial`,root);
await writeFile(partial,zip);
execFileSync('python',[fileURLToPath(new URL('scripts/verify-release.py',root)),fileURLToPath(partial),metadata.version],{stdio:'inherit'});
await rename(partial,target);
const kept=newestReleases(await readdir(new URL('dist/',root))).slice(0,2),lines=[];
for(const name of kept){const file=await safePath(fileURLToPath(root),'dist/'+name);lines.push((name===filename?createHash('sha256').update(zip).digest('hex'):await sha256(file))+'  '+name);}
const index=new URL('dist/SHA256.txt',root),indexTemp=new URL('dist/SHA256.txt.tmp',root);
await writeFile(indexTemp,lines.join('\n')+'\n');await rename(indexTemp,index);
await pruneReleases(fileURLToPath(root));
console.log('Created offline-vision ZIP:',Math.round(zip.length/1048576),'MiB');
