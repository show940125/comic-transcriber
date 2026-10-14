import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../',import.meta.url), dist=new URL('.output/chrome-mv3/',root);
const manifest=JSON.parse(await readFile(new URL('manifest.json',dist),'utf8'));
if(manifest.manifest_version!==3 || /unsafe-eval(?!')/.test(manifest.content_security_policy.extension_pages.replace('wasm-unsafe-eval',''))) throw new Error('Unsafe manifest');
async function walk(path){const out=[];for(const name of await readdir(path)){const file=new URL(name,path);if((await stat(file)).isDirectory())out.push(...await walk(new URL(name+'/',path)));else out.push(file);}return out;}
const files=await walk(dist), listing=[];
for(const file of files){const data=await readFile(file);listing.push({file:decodeURIComponent(file.href.slice(dist.href.length)),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
const lock=JSON.parse(await readFile(new URL('src/model-lock.json',root),'utf8'));
for(const model of lock.llm){if(!listing.some(f=>'/'+f.file===model.model_lib && f.sha256===model.sha256))throw new Error('Missing or wrong bundled WebLLM WASM');}
const report={manifest,files:listing,totalBytes:listing.reduce((n,f)=>n+f.bytes,0),runtimeWasmBundled:true,remoteWeightsAllowed:true,publication:'pending converted-model license review and real-manga acceptance'};
await writeFile(new URL('artifacts/package-audit.json',root),JSON.stringify(report,null,2));
console.log(JSON.stringify({files:listing.length,totalMiB:Math.round(report.totalBytes/1048576),runtimeWasmBundled:true}));
