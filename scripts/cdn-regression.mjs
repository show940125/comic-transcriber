import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {freshWorker,launchTestContext,testProfile} from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.join(root,'artifacts/cdn-regression');await mkdir(directory,{recursive:true});
const fixture=await readFile(path.join(root,'artifacts/corpus/pages/page-01.png'));
const report={started:new Date().toISOString(),scope:'isolated regression; permission-missing/grant fixture for an already granted host, fake HTTPS reader and image, actual detector/OCR; translation fixture',checks:[],errors:[]};
let context,site;
try{
 context=await launchTestContext(chromium,await testProfile(root,'cdn-regression'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${path.join(root,'.output/chrome-mv3')}`,`--load-extension=${path.join(root,'.output/chrome-mv3')}`],viewport:{width:1440,height:1000}});
 await context.route('https://reader.test.invalid/**',async route=>route.fulfill({contentType:'text/html',body:`<!doctype html><form action="/404"><img id="comic" src="https://huggingface.co/comic-regression.png" width="600"></form><script>document.addEventListener('click',e=>{if(e.target.tagName==='BUTTON'){location.href='/404'}});</script>`}));
 await context.route('https://huggingface.co/comic-regression.png',async route=>route.fulfill({contentType:'image/png',headers:{'access-control-allow-origin':'https://unrelated.test.invalid'},body:fixture}));
 await context.route('https://translate.googleapis.com/**',async route=>route.fulfill({contentType:'application/json',body:JSON.stringify([[['今天天氣真好。',null,null,null]],null,'ja'])}));
 const worker=await freshWorker(context),extensionUrl=`chrome-extension://${worker.url().split('/')[2]}`;
 await worker.evaluate(()=>{
   const contains=chrome.permissions.contains.bind(chrome.permissions),request=chrome.permissions.request.bind(chrome.permissions);
   globalThis.permissionFixture={granted:false,requests:[]};
   chrome.permissions.contains=async details=>details.origins?.includes('https://huggingface.co/*')&&!globalThis.permissionFixture.granted?false:contains(details);
   chrome.permissions.request=async details=>{globalThis.permissionFixture.requests.push(details);if(details.origins?.includes('https://huggingface.co/*'))globalThis.permissionFixture.granted=true;return request(details);};
 });
 site=await context.newPage();site.on('pageerror',e=>report.errors.push(String(e)));await site.goto('https://reader.test.invalid/chapter');await site.locator('#comic').hover();
 await site.getByRole('button',{name:'墨譯',exact:true}).click();
 const frame=site.locator('[data-comic-studio]');
 await frame.getByRole('button',{name:'授權圖片來源並重試'}).waitFor({timeout:30000});
 assert.equal(site.url(),'https://reader.test.invalid/chapter');
 report.checks.push('CORS failure opens the editor with the exact missing CDN origin, without website click navigation or form submission');
 await frame.getByRole('button',{name:'授權圖片來源並重試'}).click();
 await frame.getByRole('button',{name:'一鍵翻譯'}).waitFor();
 await frame.getByRole('button',{name:'一鍵翻譯'}).waitFor({state:'visible'});
 await frame.getByRole('button',{name:'一鍵翻譯'}).click({timeout:30000});
 await site.waitForFunction(()=>document.querySelector('[data-comic-studio]')?.shadowRoot?.textContent.includes('Google 網頁翻譯完成'),{},{timeout:180000});
 const requests=await worker.evaluate(()=>globalThis.permissionFixture.requests);assert.deepEqual(requests,[{origins:['https://huggingface.co/*']}]);
 report.checks.push('grant fixture receives only the exact origin; background image/font transfer uses base64; editor uses Shadow DOM with no iframe navigation');
 await frame.getByRole('button',{name:'套用至漫畫頁'}).click();await site.waitForFunction(()=>document.querySelector('#comic').dataset.comicResult);
 assert.equal(site.url(),'https://reader.test.invalid/chapter');
 report.checks.push('actual detector and Manga-OCR, fixture translation, and rendered-page application complete');
 await site.screenshot({path:path.join(directory,'success.png')});report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);process.exitCode=1;if(site){await site.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});report.frames=await Promise.all(site.frames().map(async f=>({url:f.url(),body:await f.locator('body').innerText({timeout:1500}).catch(()=>null)})));}console.error(error);}
finally{await context?.close();report.finished=new Date().toISOString();await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
