import {chromium} from 'playwright';import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import path from 'node:path';import assert from 'node:assert/strict';
import {testProfile,launchTestContext,freshWorker} from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'artifacts/regression-0.1.13'),ext=path.join(root,'.output/chrome-mv3');
await mkdir(out,{recursive:true});const image=await readFile(path.join(root,'artifacts/corpus/pages/page-01.png'));
const manifest=JSON.parse(await readFile(path.join(ext,'manifest.json'),'utf8'));
assert.deepEqual([...manifest.host_permissions].sort(),['http://*/*','https://*/*']);assert(!manifest.content_scripts?.some(script=>script.matches?.includes('<all_urls>')));
const report={started:new Date().toISOString(),checks:[],errors:[],fixtureOnly:true};
const cdn='a2.gold-usergeneratedcontent.net';
const server=createServer((req,res)=>{
 // Intentionally no Access-Control-Allow-Origin; extension host permissions
 // must allow the background fetch independently of the comic page origin.
 if(req.url==='/image.png'){res.setHeader('Content-Type','image/png');res.end(image);return;}
 res.setHeader('Content-Type','text/html');res.end(`<title>Original permission fixture</title><img src="http://${cdn}:${server.address().port}/image.png" width="600">`);
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let context,page;
try{
 context=await launchTestContext(chromium,await testProfile(root,'permission'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,`--host-resolver-rules=MAP manga.test 127.0.0.1, MAP ${cdn} 127.0.0.1`,'--no-proxy-server']});
 const worker=await freshWorker(context),id=worker.url().split('/')[2];page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto(`chrome-extension://${id}/options.html`);
 await page.getByRole('status').filter({hasText:'所有網站與圖片 CDN 已授權'}).waitFor();
 const access=await page.evaluate(()=>chrome.permissions.contains({origins:['http://*/*','https://*/*','https://a2.gold-usergeneratedcontent.net/*']}));assert.equal(access,true);
 await page.getByRole('button',{name:'授權所有網站與圖片 CDN',exact:true}).click();await page.getByRole('status').filter({hasText:'可直接啟用本頁墨譯或繼續翻譯'}).waitFor();report.checks.push('fresh install grants all HTTP/HTTPS including the reported CDN; restore-all button works');
 const result=await page.evaluate(url=>chrome.runtime.sendMessage({channel:'fetch-image',url}),`http://${cdn}:${server.address().port}/image.png`);assert.equal(result.ok,true,result.error);assert.equal(result.mime,'image/png');assert(Buffer.from(result.base64,'base64').equals(image));report.checks.push('background fetch reads synthetic image from unrelated CDN origin with no CORS header and no per-origin grant');
 const site=await context.newPage();await site.goto(`http://manga.test:${server.address().port}`);await site.locator('img').waitFor();assert.equal(await site.evaluate(()=>document.documentElement.hasAttribute('data-comic-active')),false);
 const status=await page.evaluate(()=>chrome.runtime.sendMessage({channel:'runtime-status'}));assert.equal(status.result.phase,'unloaded');assert.equal(status.result.worker,false);report.checks.push('broad website access does not inject tools or start inference on untouched pages');
 report.siteParsing=await page.evaluate(async()=>{const files=await(await fetch('options.html')).text();return {patterns:['http://*/*','https://*/*'].map(p=>{const u=new URL(p);return {p,host:u.hostname,path:u.pathname,allowed:!u.hostname.includes('*')};}),grants:await chrome.permissions.getAll()};});
 await page.getByLabel('在勾選網站自動翻譯可見漫畫圖片（依在途圖片設定處理）').check();
 assert.equal(await page.locator('label.check').filter({hasText:'https://*/*'}).count(),0);assert.equal(await page.locator('label.check').filter({hasText:'http://*/*'}).count(),0);
 await page.getByRole('textbox',{name:'自動翻譯網站（選用）'}).fill('https://manga.example/');await page.getByRole('button',{name:'加入網站清單',exact:true}).click();await page.getByLabel('https://manga.example/*',{exact:true}).check();await page.getByRole('button',{name:'儲存設定',exact:true}).click();await page.getByRole('status').filter({hasText:'設定已儲存'}).waitFor();
 await page.waitForFunction(async()=>{const rows=await chrome.scripting.getRegisteredContentScripts();return rows[0]?.matches?.length===1&&rows[0].matches[0]==='https://manga.example/*';});
 const scripts=await worker.evaluate(()=>chrome.scripting.getRegisteredContentScripts());assert.deepEqual(scripts[0].matches,['https://manga.example/*']);report.checks.push('automatic translation registers only the specifically selected website, never wildcard grants');
 assert.equal(report.errors.length,0);report.status='passed';await page.getByRole('button',{name:'授權所有網站與圖片 CDN',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'site-access.png')});
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;if(page){report.body=await page.locator('body').innerText({timeout:2000}).catch(()=>null);await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}}
finally{await context?.close();await new Promise(resolve=>server.close(resolve));report.finished=new Date().toISOString();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
