import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prebuiltAppConfig } from '@mlc-ai/web-llm';
const root = new URL('../', import.meta.url);
let existing={};if(!process.argv.includes('--refresh-lock'))try{existing=JSON.parse(await readFile(new URL('src/model-lock.json',root),'utf8'));}catch{}
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
async function download(url, dest, expected) {
  try { const data = await readFile(dest); if (!expected || sha(data) === expected) return data; } catch {}
  console.log('Download:', url);
  const res = await fetch(url); if (!res.ok) throw new Error(`${res.status}: ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (expected && sha(data) !== expected) throw new Error(`SHA-256 mismatch: ${url}`);
  await mkdir(new URL('.', dest), { recursive: true });
  await writeFile(dest, data); return data;
}
await mkdir(new URL('public/ort/', root), { recursive: true });
for (const name of ['@mlc-ai/web-llm', 'opencc-js', 'svelte']) {
  const filename = name === 'svelte' ? 'LICENSE.md' : 'LICENSE';
  const dir = new URL(`public/third-party-licenses/${name.replace('/', '_')}/`, root);
  await mkdir(dir, {recursive:true});await copyFile(new URL(`node_modules/${name}/${filename}`,root),new URL(filename,dir));
}
for (const [name,url] of [['onnxruntime','https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE'],['wxt','https://raw.githubusercontent.com/wxt-dev/wxt/main/LICENSE']]) await download(url,new URL(`public/third-party-licenses/${name}/LICENSE.txt`,root));
const { readdir } = await import('node:fs/promises');
for (const file of await readdir(new URL('node_modules/onnxruntime-web/dist/', root))) {
  if (/^ort-.*\.(wasm|mjs)$/.test(file)) await copyFile(new URL(`node_modules/onnxruntime-web/dist/${file}`, root), new URL(`public/ort/${file}`, root));
}
const specs = [
  { id: 'detector', repo: 'ogkalu/comic-text-and-bubble-detector', revision: '16e8a622f91fabc6b5b65c96d32d1183f8843546', files: ['detector-v4-s_int8.onnx'], license: 'apache-2.0', backend: 'wasm' },
  { id: 'manga-ocr', repo: 'mayocream/manga-ocr-onnx', revision: '24b12778d85800835e2ca409236de281b8ab7b9f', files: ['encoder_model.onnx', 'decoder_model.onnx', 'vocab.txt'], license: 'apache-2.0', backend: 'probe' },
];
const lock = { schema: 1, generated: existing.generated??new Date().toISOString(), vision: [], llm: [], font: null };
for (const spec of specs) {
  const response = await fetch(`https://huggingface.co/api/models/${spec.repo}/tree/${spec.revision}?recursive=true`);
  if (!response.ok) throw new Error('Unable to resolve model metadata');
  const metadata = await response.json();
  const files = [];
  for (const name of spec.files) {
    const meta = metadata.find(m => m.path === name);
    if (!meta) throw new Error(`Missing ${name}`);
    const url = `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${name}`;
    const digest = meta.lfs?.oid ?? sha(Buffer.from(await (await fetch(url)).arrayBuffer()));
    files.push({ name, url, sha256: digest, bytes: meta.size });
  }
  lock.vision.push({ ...spec, files });
}
const ids = ['Qwen3.5-0.8B-q4f16_1-MLC', 'Qwen3.5-0.8B-q4f32_1-MLC', 'Qwen3.5-2B-q4f16_1-MLC', 'Qwen3.5-2B-q4f32_1-MLC'];
for (const id of ids) {
  const config = prebuiltAppConfig.model_list.find(m => m.model_id === id);
  if (!config) throw new Error(`WebLLM does not support ${id}`);
  const previous=existing.llm?.find(m=>m.model_id===id);
  const metaRes = await fetch(`https://huggingface.co/api/models/mlc-ai/${id}${previous?.revision?'/revision/'+previous.revision:''}`);
  if (!metaRes.ok) throw new Error(`Missing model: ${id}`);
  const meta = await metaRes.json();
  const filename = `${id}.wasm`;
  const bytes = await download(config.model_lib, new URL(`public/mlc/${filename}`, root),previous?.sha256);
  lock.llm.push({ ...config, model: `https://huggingface.co/mlc-ai/${id}/resolve/${meta.sha}/`, model_lib: `/mlc/${filename}`, sha256: sha(bytes), revision: meta.sha, license: 'apache-2.0', licenseSource: `https://huggingface.co/Qwen/${id.includes('0.8B') ? 'Qwen3.5-0.8B' : 'Qwen3.5-2B'}`, convertedLicenseStatus: meta.cardData?.license ? 'declared' : 'upstream-only: review before publication' });
}
// OFL font for portable offline Traditional Chinese typesetting.
let fontUrl=existing.font?.url;
if(!fontUrl){const fontMeta = await (await fetch('https://api.github.com/repos/notofonts/noto-cjk/commits/main')).json();if(!fontMeta.sha)throw new Error('Font revision unavailable');fontUrl=`https://raw.githubusercontent.com/notofonts/noto-cjk/${fontMeta.sha}/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf`;}
const font = await download(fontUrl, new URL('public/fonts/NotoSansCJKtc-Regular.otf', root),existing.font?.sha256);
const oflUrl=fontUrl.replace('/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf','/Sans/LICENSE');
const oflExpected=existing.font?.licenseSha256??sha(Buffer.from(await(await fetch(oflUrl)).arrayBuffer()));
const ofl=await download(oflUrl,new URL('public/fonts/OFL.txt',root),oflExpected);
lock.font = { url: fontUrl, sha256: sha(font), license: 'OFL-1.1', licenseUrl:oflUrl,licenseSha256:sha(ofl) };
await writeFile(new URL('src/model-lock.json', root), JSON.stringify(lock, null, 2) + '\n');
await writeFile(new URL('artifacts/model-lock.json', root), JSON.stringify(lock, null, 2) + '\n');
console.log('Runtime assets and pinned model manifest prepared. Vision weights download on demand.');
