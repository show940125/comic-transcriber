import {mkdir,readFile,writeFile,createReadStream,createWriteStream} from 'node:fs';
import {mkdir as makeDir,readFile as read,writeFile as write} from 'node:fs/promises';
import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';import {createHash} from 'node:crypto';import {unzipSync} from 'fflate';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function download(url,file,expected){await makeDir(path.dirname(file),{recursive:true});try{if(!expected||await digest(file)===expected)return;}catch{}console.log('Download',url);const response=await fetch(url);if(!response.ok)throw Error(`Download failed ${response.status}`);await pipeline(Readable.fromWeb(response.body),createWriteStream(file+'.partial'));if(expected&&await digest(file+'.partial')!==expected)throw Error('SHA-256 mismatch');const{rename}=await import('node:fs/promises');await rename(file+'.partial',file);}
let lock;
try{lock=JSON.parse(await read(path.join(root,'artifacts/native-llm-lock.json'),'utf8'));}catch{
  const tag=(await(await fetch('https://github.com/ggml-org/llama.cpp/releases/download/v0.6.0/nightly-tag.txt')).text()).trim();if(!/^b\d+$/.test(tag))throw Error('Unexpected binary release tag');
  const release=await(await fetch(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`)).json();const asset=release.assets.find(a=>a.name.endsWith('win-cpu-x64.zip'));if(!asset?.digest?.startsWith('sha256:'))throw Error('No signed-digest CPU artifact');
  lock={schema:1,backend:'llama.cpp CPU, opt-in local companion',binary:{tag,url:asset.browser_download_url,sha256:asset.digest.slice(7),license:'MIT'},models:[]};
  for(const[size,revision]of[['2B','f6d5376be1edb4d416d56da11e5397a961aca8ae'],['0.8B','6ab461498e2023f6e3c1baea90a8f0fe38ab64d0']]){
    const repo=`unsloth/Qwen3.5-${size}-GGUF`,name=`Qwen3.5-${size}-Q4_K_M.gguf`,tree=await(await fetch(`https://huggingface.co/api/models/${repo}/tree/${revision}`)).json(),file=tree.find(f=>f.path===name);
    if(!file?.lfs?.oid)throw Error('Missing GGUF digest');lock.models.push({id:size==='2B'?'2b':'0.8b',name,repo,revision,url:`https://huggingface.co/${repo}/resolve/${revision}/${name}`,sha256:file.lfs.oid,bytes:file.size,license:'Apache-2.0 model-card declaration'});
  }
  await write(path.join(root,'artifacts/native-llm-lock.json'),JSON.stringify(lock,null,2));
}
const archive=path.join(root,'.cache/native/llama-cpu.zip');await download(lock.binary.url,archive,lock.binary.sha256);
const folder=path.join(root,'.cache/native',lock.binary.tag);await makeDir(folder,{recursive:true});
for(const[name,data]of Object.entries(unzipSync(new Uint8Array(await read(archive))))){if(name.endsWith('/'))continue;const dest=path.resolve(folder,name);if(!dest.startsWith(folder+path.sep))throw Error('Archive path escapes workspace');await makeDir(path.dirname(dest),{recursive:true});await write(dest,data);}
for(const model of lock.models)await download(model.url,path.join(root,'.cache/native/models',model.name),model.sha256);
console.log('Native CPU assets verified:',lock.binary.tag);
