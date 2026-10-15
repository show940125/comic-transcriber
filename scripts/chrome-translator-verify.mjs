import {chromium} from 'playwright';import {createServer} from 'node:http';import {writeFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import path from 'node:path';import {testProfile,translatorProfile,launchTestContext} from './harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),ignoredDefaultArgs=['--disable-component-update','--disable-background-networking'];
const report={started:new Date().toISOString(),ignoredDefaultArgs,reason:'Playwright normally disables the component updater required by Chrome language packs',progress:[]};
const server=createServer((q,r)=>{r.setHeader('Content-Type','text/html; charset=utf-8');r.end('<!doctype html><title>Translator probe</title><button id="run">測試本機翻譯</button>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const normal=process.env.NORMAL_TRANSLATOR_ARGS==='1',channel=process.env.TEST_TRANSLATOR_BROWSER??'chromium';
report.channel=channel;report.normalArguments=normal;
const profile=normal?await translatorProfile(root):await testProfile(root,'translator-components');report.profile=profile;
let context;
try{
 context=await launchTestContext(chromium,profile,{channel,headless:true,timeout:60000,ignoreDefaultArgs:normal?true:ignoredDefaultArgs,...(normal?{args:[`--user-data-dir=${profile}`,'--remote-debugging-pipe','--headless=new','--no-first-run','--no-default-browser-check']}:{} )},{retain:()=>normal&&report.status==='passed-actual-local-translation'});
 const page=await context.newPage();page.on('console',message=>{if(message.text().startsWith('download:')){report.progress.push({time:new Date().toISOString(),text:message.text()});console.log(message.text());}});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForLoadState('networkidle');report.userAgent=await page.evaluate(()=>navigator.userAgent);
 report.availability=await page.evaluate(async()=>'Translator' in self?await Translator.availability({sourceLanguage:'ja',targetLanguage:'zh-Hant'}):'API absent');console.log('availability:',report.availability);
 if(['unavailable','API absent'].includes(report.availability)){report.status='unavailable';}
 else{
  await page.evaluate(()=>{document.querySelector('#run').onclick=async()=>{const started=performance.now();let t;try{t=await Translator.create({sourceLanguage:'ja',targetLanguage:'zh-Hant',signal:AbortSignal.timeout(180000),monitor(m){m.addEventListener('downloadprogress',e=>console.log('download:'+e.loaded));}});const rows=[];for(const source of ['今日はいい天気だね。','一緒に帰ろう。','大丈夫ですか？']){const before=performance.now();rows.push({source,text:await t.translate(source),ms:performance.now()-before});}window.__result={status:'passed-actual-local-translation',rows,initializationMs:performance.now()-started};}catch(error){window.__result={status:'initialization-failed',error:String(error),ms:performance.now()-started};}finally{t?.destroy();}};});
  await page.locator('#run').click();await page.waitForFunction(()=>window.__result,undefined,{timeout:240000});Object.assign(report,await page.evaluate(()=>window.__result));
 }
}catch(error){report.status='unverified';report.error=String(error);}
finally{await context?.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(root,normal&&report.status==='passed-actual-local-translation'?'artifacts/chrome-translator-installed.json':'artifacts/chrome-translator-components.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
