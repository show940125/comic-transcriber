// Owned foreground benchmark: private loopback server and isolated headless browser.
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=path.join(root,'artifacts/research-ocr');
const variants=(process.argv[2]??'baseline,int8').split(',');
const js=await build({entryPoints:[path.join(root,'scripts/research-ocr/web-client.js')],bundle:true,write:false,format:'esm',platform:'browser'});
const bundleSha256=createHash('sha256').update(js.outputFiles[0].contents).digest('hex');
await writeFile(path.join(out,`web-client-${bundleSha256}.js`),js.outputFiles[0].contents);
let current='';
const server=createServer(async(req,res)=>{
 try{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/checkpoint'&&req.method==='POST'){
   const chunks=[];for await(const c of req)chunks.push(c);
   const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(data.variant!==current)throw Error('variant mismatch');
   await writeFile(path.join(out,'results',`web-${current}.json`),JSON.stringify(data,null,2));
   console.log(`${current}: ${data.results.length} rows, ${data.performance.length} warm runs, ${data.status}`);res.end('saved');return;
  }
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><h1>Standalone OCR research</h1><p id="status">Ready</p><script type="module" src="/client.js"></script>');return;}
  if(url.pathname==='/client.js'){res.setHeader('Content-Type','text/javascript');res.end(js.outputFiles[0].contents);return;}
  const aliases=[['/data/',out],['/ort/',path.join(root,'public/ort')],['/baseline/',path.join(root,'.cache/models/manga-ocr')]];
  const route=aliases.find(([prefix])=>url.pathname.startsWith(prefix));if(!route){res.writeHead(404).end();return;}
  const target=path.resolve(route[1],decodeURIComponent(url.pathname.slice(route[0].length)));
  if(!target.startsWith(path.resolve(route[1])+path.sep)){res.writeHead(403).end();return;}
  const info=await stat(target);if(!info.isFile())throw Error('Not a file');
  res.setHeader('Content-Type',target.endsWith('.wasm')?'application/wasm':/\.m?js$/.test(target)?'text/javascript':target.endsWith('.json')?'application/json':'application/octet-stream');
  res.setHeader('Content-Length',info.size);createReadStream(target).pipe(res);
 }catch(error){res.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=`http://127.0.0.1:${server.address().port}`;
try{
 for(const spec of variants){
  const [label,selection='all',preprocessing='frozen']=spec.split(':');const [variant,rawThreads='1']=label.split('@');const threads=Number(rawThreads);
  if(![1,2,4].includes(threads)||!['all','sample'].includes(selection))throw Error('Invalid research configuration');
  const key=variant+(threads===1?'':`-t${threads}`)+(selection==='sample'?'-sample':'')+(preprocessing==='canvas'?'-canvas':'');
  if(!['baseline','int8','kv','hybrid','qint8','quint8','portable'].includes(variant))throw Error('Unknown variant');
  current=key;let browser;const receipt={variant:key,modelVariant:variant,threads,selection,status:'running',startedAt:new Date().toISOString(),bundleSha256,blockedRequests:[],consoleErrors:[],datasetSha256:createHash('sha256').update(await readFile(path.join(out,'dataset.json'))).digest('hex')};
  try{
   browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking','--disable-component-update']});
   receipt.browserVersion=browser.version();
   const context=await browser.newContext();
   await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.hostname==='127.0.0.1')await route.continue();else{receipt.blockedRequests.push(url.origin);await route.abort();}});
   const page=await context.newPage();page.on('pageerror',error=>receipt.consoleErrors.push(String(error)));
   await page.goto(address);await page.waitForLoadState('networkidle');await page.waitForFunction(()=>typeof window.runResearch==='function');
   const result=await page.evaluate(config=>window.runResearch(config),{variant,key,threads,selection,preprocessing});receipt.status=result.status;receipt.error=result.error;receipt.completedAt=new Date().toISOString();
   receipt.jsHeap=await page.evaluate(()=>performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize,scope:'JS heap only, excludes native/WASM and other browser processes'}:null);
   const cdp=await browser.newBrowserCDPSession();const processes=await cdp.send('SystemInfo.getProcessInfo');
   receipt.processMemory=JSON.parse(execFileSync('python',[path.join(root,'scripts/research-ocr/process_memory.py'),JSON.stringify(processes.processInfo)],{encoding:'utf8'}));
   await page.screenshot({path:path.join(out,`web-${key}.png`)});
  }catch(error){receipt.status='failed';receipt.error=String(error);console.log(`${variant} failed: ${error}`);}
  finally{await browser?.close();await writeFile(path.join(out,'results',`web-${key}-receipt.json`),JSON.stringify(receipt,null,2));}
 }
}finally{await new Promise(resolve=>server.close(resolve));}
