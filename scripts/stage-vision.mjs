import { cp, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await mkdir(new URL('.output/chrome-mv3/models/',root),{recursive:true});
for (const model of ['detector', 'manga-ocr']) await cp(new URL(`.cache/models/${model}/`,root),new URL(`.output/chrome-mv3/models/${model}/`,root),{recursive:true});
console.log('Staged vision weights in unpacked extension for offline use. Rebuild removes these staged files.');
