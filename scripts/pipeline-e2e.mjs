import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {spawn} from 'node:child_process';
import {testProfile,freshWorker} from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),browser=process.env.TEST_BROWSER??'chromium',label=browser==='msedge'?'edge':'chrome';
const ext=path.join(root,'.output/chrome-mv3'),fixture=process.env.TEST_IMAGE??path.join(root,'artifacts/corpus/pages/page-01.png');
const out=path.join(root,'artifacts',`pipeline-${label}`);await mkdir(out,{recursive:true});
const report={schema:1,browser,started:new Date().toISOString(),checks:[],network:[],blocked:[],source:fixture,usesGroundTruth:false};
let local;const localEnabled=process.env.TEST_LOCAL_FALLBACK==='real';
if(localEnabled){local=createServer(async(q,r)=>{r.setHeader('Access-Control-Allow-Origin','*');r.setHeader('Access-Control-Allow-Headers','Content-Type');if(q.method==='OPTIONS'){r.end();return;}const parts=[];for await(const p of q)parts.push(p);const body=JSON.parse(Buffer.concat(parts)),child=spawn('python',[path.join(root,'backend/native_pipe.py')],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.on('close',code=>{r.setHeader('Content-Type','application/json');if(code!==0){r.statusCode=400;r.end(JSON.stringify({error}));return;}const value=JSON.parse(output);r.end(JSON.stringify({backend:value.backend,choices:[{message:{content:value.content}}],ms:value.ms}));});child.stdin.end(JSON.stringify(body));});await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));}
const context=await chromium.launchPersistentContext(await testProfile(root,`pipeline-${label}`),{channel:browser,headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`],viewport:{width:1440,height:1000}});
let page;
try{
 const worker=await freshWorker(context),id=worker.url().split('/')[2];page=await context.newPage();
 await page.goto(`chrome-extension://${id}/options.html`);await page.waitForLoadState('networkidle');
 assert.equal(await page.getByLabel('執行方式').inputValue(),'google-web');
 if(localEnabled){await page.getByLabel('翻譯來源失敗時，改用已設定的本機服務').check();await page.getByLabel('本機 Base URL').fill(`http://127.0.0.1:${local.address().port}/v1`);await page.getByLabel('模型名稱').fill('qwen3.5-2b');}
 await page.getByLabel('瀏覽器 OCR 後端').selectOption('wasm');await page.getByRole('button',{name:'儲存設定',exact:true}).click();await page.getByRole('status').filter({hasText:'設定已儲存'}).waitFor();
 await page.goto(`chrome-extension://${id}/reader.html`);await page.waitForLoadState('networkidle');report.userAgent=await page.evaluate(()=>navigator.userAgent);
 await context.route('https://**/*',route=>{if(route.request().url().startsWith('https://translate.googleapis.com/translate_a/single?'))return route.continue();report.blocked.push(route.request().url());return route.abort();});
 context.on('request',r=>{if(/^https?:/.test(r.url()))report.network.push({url:r.url(),method:r.method(),hasBody:r.postData()!==null});});
 await page.locator('input[accept="image/*"]').setInputFiles(fixture);await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='一鍵翻譯')?.disabled);
 const started=performance.now();await page.getByRole('button',{name:'一鍵翻譯',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.error')||document.querySelector('.status')?.textContent.includes('翻譯完成'),undefined,{timeout:600000});
 assert.equal(await page.locator('.error').count(),0,await page.locator('.error').allTextContents());await page.getByRole('button',{name:'一鍵翻譯',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='一鍵翻譯')?.disabled);
 report.pipelineMs=performance.now()-started;
 const [json]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'匯出校正 JSON'}).click()]);await json.saveAs(path.join(out,'correction.json'));
 const output=JSON.parse(await readFile(path.join(out,'correction.json'),'utf8'));report.regions=output.regions.length;report.diagnostics=output.diagnostics;report.rows=output.regions.map(({id,source,translation,warnings})=>({id,source,translation,warnings}));
 assert(output.regions.length>0);assert(output.regions.filter(r=>r.source.trim()).every(r=>r.translation.trim()));assert.equal(new Set(output.regions.map(r=>r.id)).size,output.regions.length);
 assert(report.network.filter(r=>!report.blocked.includes(r.url)).every(r=>(r.url.startsWith('https://translate.googleapis.com/translate_a/single?')&&r.method==='GET'&&!r.hasBody)||(localEnabled&&r.url===`http://127.0.0.1:${local.address().port}/v1/chat/completions`)));
 assert(report.blocked.length===0,'Packaged OCR must not need remote model downloads');report.checks.push('fresh-profile default free Google route; real detection + WASM Manga-OCR + text translation; no GT import or LLM download');
 const [png]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'匯出 PNG'}).click()]);await png.saveAs(path.join(out,'translated.png'));await page.screenshot({path:path.join(out,'reader.png'),fullPage:true});
 const translated=await page.evaluate(()=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(0,0,document.querySelector('canvas').width,document.querySelector('canvas').height).data));
 await page.getByRole('button',{name:'切回原圖'}).click();const raw=await page.evaluate(()=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(0,0,document.querySelector('canvas').width,document.querySelector('canvas').height).data));
 let changed=0,outside=0;for(let i=0;i<raw.length;i+=4)if(raw[i]!==translated[i]||raw[i+1]!==translated[i+1]||raw[i+2]!==translated[i+2]){changed++;const x=(i/4)%output.width,y=Math.floor(i/4/output.width);if(!output.regions.some(r=>x>=r.x-1&&x<=r.x+r.width+1&&y>=r.y-1&&y<=r.y+r.height+1))outside++;}
 assert(changed>30);assert.equal(outside,0);report.changedPixels=changed;report.checks.push('PNG export and original toggle preserve pixels outside every text region');
 const requests=report.network.length;await page.getByRole('button',{name:'一鍵翻譯',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.status')?.textContent.includes('已載入完成的譯文'));assert.equal(report.network.length,requests);report.checks.push('repeated completed-page trigger reuses translations without external requests');
 report.status='passed-full-pipeline';report.actualBackends=[...new Set(output.diagnostics.map(d=>d.backend).filter(Boolean))];report.localFallbackEnabled=localEnabled;
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;if(page){report.body=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}}
finally{await context.close();if(local)await new Promise(resolve=>local.close(resolve));report.finished=new Date().toISOString();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,browser,regions:report.regions,pipelineMs:report.pipelineMs,actualBackends:report.actualBackends,checks:report.checks,error:report.error},null,2));}
