// Interactive local regression host. Browser interaction uses the documented
// browser tool; this script never launches or attaches to a browser.
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'artifacts/regression-0.1.9');await mkdir(out,{recursive:true});
const chapter=path.join(out,'chapter-21');
let files=[];try{files=(await readdir(chapter)).filter(n=>/^\d+\.jpg$/.test(n)).sort((a,b)=>parseInt(a)-parseInt(b));}catch{}
if(!files.length)throw new Error('Place privately acquired numbered JPEG fixtures in artifacts/regression-0.1.9/chapter-21 first.');
const worker=(await readdir(path.join(root,'.output/chrome-mv3/assets'))).find(n=>/^engine\.worker.*\.js$/.test(n));
await build({entryPoints:[path.join(root,'scripts/browser-regression-client.ts')],bundle:true,format:'esm',outfile:path.join(out,'client.js'),define:{REGRESSION_FILES:JSON.stringify(files),REGRESSION_WORKER:JSON.stringify('/assets/'+worker)}});
if(process.argv.includes('--build-only')){console.log('Regression client rebuilt');process.exit(0);}
const html=`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>墨譯 0.1.9 本機回歸</title><style>body{font:15px sans-serif;margin:24px;background:#f1eee6;color:#25362f}button{padding:12px;margin:6px}section{display:flex;gap:16px}figure{margin:10px 0}canvas{width:min(42vw,800px);height:auto}pre{white-space:pre-wrap;max-height:400px;overflow:auto}#output section{align-items:flex-start}</style><h1>墨譯 0.1.9 本機回歸</h1><p>正式 ONNX Worker 與頁面管線；漫畫檔案只在本機。效能比較使用固定 Google 回覆及 300 ms 延遲，避免大量外部請求。</p><button id="visual">測第三／四張（Google 實際文字翻譯）</button><button id="benchmark">整章速度比較：冷啟動＋暖機各五次</button><button id="native">比較 Chrome 本機翻譯</button><button id="finish">結束測試伺服器</button><p id="status" role="status">待測</p><pre id="metrics"></pre><div id="output"></div><script type="module" src="/client.js"></script></html>`;
let liveGoogleTail=Promise.resolve(),lastGoogle=0;
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/finish'&&req.method==='POST'){res.end('closed');server.close();return;}
  if(url.pathname==='/report'&&req.method==='POST'){
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>8_000_000)throw new Error('report too large');chunks.push(chunk);}
   const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));const name=['visual','benchmark','native','error'].includes(data.kind)?data.kind:'error';await writeFile(path.join(out,name+'.json'),JSON.stringify(data,null,2));res.end('saved');return;
  }
  if(url.pathname==='/google'&&req.method==='POST'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const {source}=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof source!=='string'||!source.trim()||source.length>1500)throw new Error('invalid source');
   const task=liveGoogleTail.catch(()=>{}).then(async()=>{const wait=Math.max(0,lastGoogle+250-performance.now());if(wait)await new Promise(r=>setTimeout(r,wait));lastGoogle=performance.now();const target=new URL('https://translate.googleapis.com/translate_a/single');target.search=new URLSearchParams({client:'gtx',sl:'ja',tl:'zh-TW',dt:'t',q:source}).toString();const response=await fetch(target,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});return {ok:true,status:response.status,data:response.ok?await response.json():null};});liveGoogleTail=task;const response=await task;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));return;
  }
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  const route=url.pathname==='/client.js'?path.join(out,'client.js'):['/visual.json','/benchmark.json','/native.json'].includes(url.pathname)?path.join(out,path.basename(url.pathname)):url.pathname.startsWith('/pages/')?path.join(chapter,path.basename(url.pathname)):path.join(root,'.output/chrome-mv3',url.pathname.slice(1));
  const allowed=[out,path.join(root,'.output/chrome-mv3')].some(base=>path.resolve(route).startsWith(path.resolve(base)+path.sep));if(!allowed){res.writeHead(403).end();return;}
  const info=await stat(route);if(!info.isFile()){res.writeHead(404).end();return;}
  const ext=path.extname(route);res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.jpg':'image/jpeg','.otf':'font/otf'})[ext]??'application/octet-stream');res.setHeader('Content-Length',info.size);createReadStream(route).pipe(res);
 }catch(error){res.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,pages:files.length,worker}));
