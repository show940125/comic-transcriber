import { copyFile, mkdir,readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root = new URL('../', import.meta.url);
await mkdir(new URL('.output/chrome-mv3/models/',root),{recursive:true});
const lock=JSON.parse(await readFile(new URL('src/model-lock.json',root),'utf8')),refs=Object.values(lock.ocrProfiles.int8).filter(v=>v&&typeof v==='object');
const selected=[...lock.vision.find(m=>m.id==='detector').files.map(file=>({model:'detector',file:file.name})),...refs];
for(const ref of selected){const spec=lock.vision.find(m=>m.id===ref.model).files.find(f=>f.name===ref.file),source=new URL(`.cache/models/${ref.model}/${ref.file}`,root),bytes=await readFile(source);if(createHash('sha256').update(bytes).digest('hex')!==spec.sha256)throw Error('Model digest mismatch: '+ref.file);await mkdir(new URL(`.output/chrome-mv3/models/${ref.model}/`,root),{recursive:true});await copyFile(source,new URL(`.output/chrome-mv3/models/${ref.model}/${ref.file}`,root));}
console.log('Staged vision weights in unpacked extension for offline use. Rebuild removes these staged files.');
await import('./bundle-inventory.mjs');
