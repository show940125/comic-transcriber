import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
const root=new URL('../',import.meta.url),directory=new URL('.output/chrome-mv3/',root),files={};
const metadata=JSON.parse(await readFile(new URL('package.json',root),'utf8')),filename=`comic-transcriber-${metadata.version}-offline-vision.zip`;
async function walk(dir,prefix=''){for(const name of await readdir(dir)){const file=new URL(name,dir);if((await stat(file)).isDirectory())await walk(new URL(name+'/',dir),prefix+name+'/');else files[prefix+name]=new Uint8Array(await readFile(file));}}
await walk(directory);files['LICENSE']=strToU8(await readFile(new URL('LICENSE',root),'utf8'));files['NOTICE.md']=strToU8(await readFile(new URL('NOTICE.md',root),'utf8'));
await mkdir(new URL('dist/',root),{recursive:true});const zip=zipSync(files,{level:6});
const target=new URL(`dist/${filename}`,root);await writeFile(target,zip);
await writeFile(new URL('dist/SHA256.txt',root),createHash('sha256').update(zip).digest('hex')+'  '+filename+'\n');
console.log('Created offline-vision ZIP:',Math.round(zip.length/1048576),'MiB');
