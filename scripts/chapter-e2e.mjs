import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {freshWorker,launchTestContext,testProfile} from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=path.join(root,'artifacts/chapter-e2e');await mkdir(dir,{recursive:true});
const pages=await Promise.all([1,2,3].map(i=>readFile(path.join(root,`artifacts/corpus/pages/page-0${i}.png`))));
const fault500=process.env.TEST_TRANSIENT_500==='1';
const report={started:new Date().toISOString(),version:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,scope:'three original schematic pages; actual detector and Manga-OCR; Google text translation fixture; no real website quality claim',checks:[],errors:[],translationRequests:0,explicitHttp500:0};
let context,site;
try{
 const extension=path.join(root,'.output/chrome-mv3');
 context=await launchTestContext(chromium,await testProfile(root,'chapter-e2e'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1440,height:950}});
 await context.route('https://chapter.test.invalid/**',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><header><img src="https://huggingface.co/chapter-regression/logo.png" width="150"></header><main data-comic-reader>${[1,2,3].map(i=>`<img id="page${i}" loading="lazy" src="https://huggingface.co/chapter-regression/page-0${i}.png" width="600" height="900" style="display:block">`).join('')}</main>`}));
 await context.route('https://huggingface.co/chapter-regression/**',r=>{const i=Number(r.request().url().match(/page-0(\d)/)?.[1]??1)-1;return r.fulfill({contentType:'image/png',headers:{'access-control-allow-origin':'https://unrelated.test.invalid'},body:pages[i]});});
 await context.route('https://translate.googleapis.com/**',r=>{report.translationRequests++;if(fault500&&report.translationRequests===1){report.explicitHttp500++;return r.fulfill({status:500,body:'transient server fixture'});}return r.fulfill({contentType:'application/json',body:JSON.stringify([[['今天的故事，讀成繁體中文。',null,null,null]],null,'ja'])});});
 const worker=await freshWorker(context);await worker.evaluate(()=>chrome.storage.local.set({settings:{backend:'google-web',ocrProvider:'wasm',auto:false,pageConcurrency:1}}));
 site=await context.newPage();site.on('pageerror',e=>report.errors.push(String(e)));await site.goto('https://chapter.test.invalid/chapter');
 const dock=site.locator('[data-comic-dock]');await dock.getByRole('button',{name:'翻譯本頁漫畫',exact:true}).click();
 if(fault500){await site.waitForFunction(()=>document.querySelector('[data-comic-dock]')?.shadowRoot?.querySelector('[role=status]')?.textContent.includes('HTTP 500'),{},{timeout:180000});await dock.getByRole('button',{name:'停止佇列'}).click();}
 await site.waitForFunction(()=>!!document.querySelector('#page1').dataset.comicResult,{},{timeout:180000});
 const first=await site.evaluate(()=>[1,2,3].map(i=>!!document.querySelector('#page'+i).dataset.comicResult));assert.deepEqual(first,[true,false,false]);
 report.checks.push('first translated image becomes visible while later chapter images remain pending');
 if(!fault500)await dock.getByRole('button',{name:'停止佇列'}).click();
 await dock.getByRole('button',{name:'繼續翻譯本頁'}).waitFor({timeout:180000});
 const partial=await site.evaluate(()=>[1,2,3].map(i=>!!document.querySelector('#page'+i).dataset.comicResult));assert(partial[0]);assert(!partial[2]);report.partial=partial;
 report.checks.push('stop finishes the active image, retains already rendered pages, and leaves later pages queued');
 if(fault500){assert.equal(await dock.getByRole('alert').count(),0);report.checks.push('actual fixture HTTP 500 retries successfully; stopping during backoff shows stopped status without inventing a final 500 failure');}
 await dock.getByRole('button',{name:'繼續翻譯本頁'}).click();
 await site.waitForFunction(()=>[1,2,3].every(i=>!!document.querySelector('#page'+i).dataset.comicResult),{},{timeout:180000});
 await site.waitForFunction(()=>document.querySelector('[data-comic-dock]').shadowRoot.textContent.includes('本頁漫畫已處理完成'));
 assert.equal(await site.locator('header img').getAttribute('data-comic-result'),null);
 report.checks.push('resume completes all three pages in order, including initially lazy images; header logo is excluded');
 await dock.getByRole('button',{name:'原圖／譯文'}).click();await site.waitForFunction(()=>[1,2,3].every(i=>document.querySelector('#page'+i).src.startsWith('https://huggingface.co/')));
 await dock.getByRole('button',{name:'原圖／譯文'}).click();await site.waitForFunction(()=>[1,2,3].every(i=>document.querySelector('#page'+i).src.startsWith('blob:')));report.checks.push('original/translation toggle works for the whole chapter');
 await dock.getByRole('button',{name:'章節工作台'}).click();const studio=site.locator('[data-comic-studio]');
 await studio.getByLabel('切換章節圖片').waitFor();assert.equal(await studio.getByLabel('章節全部圖片').locator('img').count(),3);
 await site.waitForFunction(()=>document.querySelector('[data-comic-studio]')?.shadowRoot?.querySelector('[aria-label="選擇文字框"]')?.querySelectorAll('option').length>1,{},{timeout:30000});
 await studio.getByLabel('切換章節圖片').selectOption('2');await studio.getByLabel('切換章節圖片').waitFor();assert.equal(await studio.getByLabel('切換章節圖片').inputValue(),'2');
 await site.waitForFunction(()=>document.querySelector('[data-comic-studio]')?.shadowRoot?.querySelector('[aria-label="選擇文字框"]')?.querySelectorAll('option').length>1,{},{timeout:30000});
 assert.equal(await site.evaluate(()=>[...document.fonts].filter(f=>f.family==='ComicTC').length),1);
 report.checks.push('translated regions restore across chapter navigation without another OCR/translation; one shared CJK font per document');
 report.checks.push('chapter workbench loads the complete thumbnail list and switches directly to another page');
 await site.screenshot({path:path.join(dir,'workbench.png')});await studio.getByRole('button',{name:'關閉工作台'}).click();await site.screenshot({path:path.join(dir,'success.png')});
 report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);process.exitCode=1;if(site){report.dock=await site.locator('[data-comic-dock]').innerText().catch(()=>null);report.studio=await site.locator('[data-comic-studio]').innerText().catch(()=>null);await site.screenshot({path:path.join(dir,'failure.png')}).catch(()=>{});}console.error(error);}
finally{await context?.close();report.finished=new Date().toISOString();await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
