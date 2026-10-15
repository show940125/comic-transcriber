import {readdir,stat,writeFile} from 'node:fs/promises';
const root=new URL('../.output/chrome-mv3/',import.meta.url),groups=new Map();
async function walk(dir,prefix=''){for(const name of await readdir(dir)){if(name==='bundle-inventory.json')continue;const url=new URL(name,dir),s=await stat(url);if(s.isDirectory())await walk(new URL(name+'/',dir),prefix+name+'/');else{const key=prefix.startsWith('models/')?'內建模型':prefix.startsWith('ort/')||prefix.startsWith('mlc/')||/\.wasm$/.test(name)?'執行資源':prefix.startsWith('fonts/')?'字型':'介面與其他資源';const row=groups.get(key)??{name:key,files:0,bytes:0};row.files++;row.bytes+=s.size;groups.set(key,row);}}}
await walk(root);await writeFile(new URL('bundle-inventory.json',root),JSON.stringify({schema:1,groups:[...groups.values()]},null,2));
