import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';
import {defaults} from '../src/types.ts';
import {contentSignature} from '../src/core.ts';

const args=process.argv.slice(2),arg=(name)=>args[args.indexOf(name)+1];
if(!args.includes('--extension')||!args.includes('--output'))throw Error('Use --extension <isolated extension> --output <temporary evidence directory> [--baseline] [--browser edge]');
const extension=path.resolve(arg('--extension')),out=path.resolve(arg('--output')),baseline=args.includes('--baseline'),edge=arg('--browser')==='edge';
await mkdir(out,{recursive:true});
const report={started:new Date().toISOString(),baseline,browser:edge?'Edge':'Chromium',checks:[],dns:[],errors:[],externalRequests:[]};
function png(seed){
  const crc=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;};
  const chunk=(name,data)=>{const tag=Buffer.from(name),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([tag,data])));return Buffer.concat([len,tag,data,sum]);};
  const w=600,h=800,raw=Buffer.alloc((w*3+1)*h,255);for(let y=0;y<h;y++){raw[y*(w*3+1)]=0;for(let x=0;x<w;x++)if(x>100&&x<500&&(y===100+seed||y===350||x===101||x===499)&&y>=100&&y<=350)raw.fill(20,y*(w*3+1)+1+x*3,y*(w*3+1)+1+x*3+3);}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const images=[png(0),png(2)],hashes=images.map(b=>createHash('sha256').update(b).digest('hex'));
const region={id:'region-a',x:150,y:150,width:200,height:100,order:0,source:'こんにちは',translation:'',score:1,warnings:[],kind:'bubble',render:'rectangle',ocrDone:true};
const pages=images.map((_,i)=>({schema:1,hash:hashes[i],width:600,height:800,regions:[{...region}],title:'Original security fixture',chapter:'1',glossary:'',summary:'',modelKey:contentSignature(defaults),sourcePageUrl:'https://manga.fixture.test/chapter',imageUrl:`https://cdn.fixture.test/${i}.png`,pageIndex:i}));
const correction={...pages[0],regions:[{...region,translation:'已匯入的校正',secret:'RAW-PRIVATE-SENTINEL',ocrBox:{x:150,y:150,width:200,height:100,secret:'NESTED-PRIVATE-SENTINEL'}}],secret:'ROOT-PRIVATE-SENTINEL'};
const privateIp=Object.values(networkInterfaces()).flat().find(n=>n.family==='IPv4'&&!n.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address))?.address;
const servers=[];
async function fixtureServer(address){const server=createServer((req,res)=>{report.dns.push({host:req.headers.host,path:req.url,remote:req.socket.remoteAddress});if(req.url==='/redirect'){res.writeHead(302,{Location:'https://cdn.fixture.test/0.png'});res.end();return;}res.setHeader('Content-Type','image/png');res.end(images[0]);});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,address,resolve);});servers.push(server);return server.address().port;}
let context,site,worker,reader,importer,heldTranslation,blockTranslation=false;
try{
  const loopPort=await fixtureServer('127.0.0.1');let privatePort;
  if(privateIp){try{privatePort=await fixtureServer(privateIp);}catch(e){report.dns.push({privateFixtureUnavailable:String(e)});}}
  const mappings=`MAP dns-loopback.fixture.test 127.0.0.1${privatePort?`, MAP dns-private.fixture.test ${privateIp}`:''}`;
  context=await chromium.launchPersistentContext(await mkdtemp(path.join(out,'profile-')),{channel:edge?'msedge':'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--host-resolver-rules=${mappings}`],viewport:{width:1360,height:1000},acceptDownloads:true});
  report.version=context.browser()?.version();
  await context.route(/^https?:\/\//,async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='dns-loopback.fixture.test'||url.hostname==='dns-private.fixture.test')return route.continue();
    if(url.hostname==='manga.fixture.test')return route.fulfill({contentType:'text/html',body:`<!doctype html><title>Original hostile host fixture</title><div data-comic-reader><img id="comic" src="https://cdn.fixture.test/0.png" width="600"><img src="https://cdn.fixture.test/1.png" width="600"></div><script>window.hostFiles=[];document.addEventListener('change',e=>{if(e.target.files)hostFiles.push(e.target.files.length)},true)</script>`});
    if(url.hostname==='cdn.fixture.test')return route.fulfill({contentType:'image/png',body:images[url.pathname.startsWith('/1')?1:0]});
    if(url.hostname==='translate.googleapis.com'){if(blockTranslation){heldTranslation=route;return;}return route.fulfill({contentType:'application/json',body:JSON.stringify([[['你好。']]])});}
    report.externalRequests.push(route.request().url());return route.abort();
  });
  worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker',{timeout:20_000});
  const extensionUrl=worker.url().split('/').slice(0,3).join('/');
  await worker.evaluate(async({pages,defaults})=>{const data={settings:{...defaults,refineAfterChapter:false},pageKeys:pages.map(p=>'page:'+p.hash+':'+p.modelKey)};for(const p of pages)data['page:'+p.hash+':'+p.modelKey]=p;await chrome.storage.local.set(data);},{pages,defaults});
  site=await context.newPage();site.on('pageerror',e=>report.errors.push(String(e)));await site.goto('https://manga.fixture.test/chapter');
  await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url?.startsWith('https://manga.fixture.test/'));await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content-scripts/content.js']});});
  async function openEditor(){await site.locator('#comic').hover();await site.getByRole('button',{name:'墨譯',exact:true}).click();await site.locator('[data-comic-studio] canvas').waitFor();return site.locator('[data-comic-studio]');}
  let editor=await openEditor();
  if(baseline){
    assert.equal(await editor.locator('input[type=file]').count(),2);
    await editor.getByLabel('載入校正 JSON').setInputFiles({name:'private-correction.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(correction))});
    const leaked=await site.evaluate(async()=>document.querySelector('[data-comic-studio]').shadowRoot.querySelector('input[aria-label="載入校正 JSON"]').files[0].text());
    assert(leaked.includes('ROOT-PRIVATE-SENTINEL'));report.checks.push('baseline reproduced: hostile host reads full selected correction File including non-rendered private sentinel');
    await site.screenshot({path:path.join(out,'baseline.png')});
  }else{
    assert.equal(await editor.locator('input[type=file]').count(),0);report.checks.push('in-page editor has no extension-owned file input');
    const localPage=context.waitForEvent('page');await editor.getByRole('button',{name:'選擇本機圖片（獨立工作台）'}).click();reader=await localPage;await reader.waitForURL(extensionUrl+'/reader.html');
    await reader.locator('input[type=file][accept="image/*"]').setInputFiles({name:'private-original.png',mimeType:'image/png',buffer:images[1]});await reader.locator('canvas').waitFor();assert.equal(await editor.locator('input[type=file]').count(),0);report.checks.push('local image selection and preview work only in top-level extension reader');
    await reader.waitForFunction(()=>!document.querySelector('input[aria-label="載入校正 JSON"]').disabled);await reader.getByLabel('載入校正 JSON').setInputFiles({name:'private.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...pages[1],regions:[{...region,translation:'PRIVATE-CACHE-SENTINEL'}]}))});await reader.waitForFunction(()=>document.querySelector('.status')?.textContent.includes('校正已載入'));
    await site.getByLabel('切換章節圖片').selectOption('1');await site.waitForFunction(()=>document.querySelector('[data-comic-studio]')?.shadowRoot?.querySelector('select[aria-label="切換章節圖片"]')?.value==='1');
    await editor.getByLabel('選擇文字框',{exact:true}).selectOption('region-a');assert.notEqual(await editor.getByLabel('繁中譯文',{exact:true}).inputValue(),'PRIVATE-CACHE-SENTINEL');
    await site.getByLabel('切換章節圖片').selectOption('0');await site.waitForFunction(()=>document.querySelector('[data-comic-studio]')?.shadowRoot?.querySelector('select[aria-label="切換章節圖片"]')?.value==='0');report.checks.push('private standalone corrections cannot be read through same-image website cache');
    await site.evaluate(url=>{const frame=document.createElement('iframe');frame.id='legacy-reader';frame.src=url;document.body.append(frame);},extensionUrl+'/reader.html');
    const legacy=await site.locator('#legacy-reader').elementHandle().then(el=>el.contentFrame());
    try{await legacy.waitForURL(extensionUrl+'/reader.html',{timeout:5000});await legacy.locator('main').waitFor({timeout:5000});assert.equal(await legacy.locator('input[type=file]').count(),0);report.checks.push('legacy extension reader iframe has no file input');}catch(e){if(legacy.url().startsWith(extensionUrl))throw e;report.checks.push('legacy reader iframe blocked by browser; no file surface available');}
    await site.evaluate(()=>document.querySelector('#legacy-reader').remove());
    async function openImport(){const next=context.waitForEvent('page');await editor.getByRole('button',{name:'載入校正（獨立分頁）'}).click();const page=await next;await page.waitForURL(extensionUrl+'/correction-import.html#*');await page.locator('#file').waitFor();await page.waitForFunction(()=>!document.querySelector('#file').disabled);return page;}
    importer=await openImport();await importer.evaluate(()=>{globalThis.sentImports=[];const send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(message)=>{globalThis.sentImports.push(message);return send(message);};});
    for(const bad of [{...correction,hash:'f'.repeat(64)},{...correction,width:601},{...correction,regions:[region,region]},{...correction,regions:[{...region,x:590}]}]){await importer.locator('#file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bad))});await importer.waitForFunction(()=>document.querySelector('#status').textContent.includes('Error:'));assert(await importer.locator('#submit').isDisabled());}
    await importer.locator('#file').setInputFiles({name:'large.json',mimeType:'application/json',buffer:Buffer.alloc(2*1024*1024+1,32)});await importer.getByRole('status').filter({hasText:'2 MB'}).waitFor();
    await importer.locator('#file').setInputFiles({name:'good.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(correction))});await importer.getByRole('status').filter({hasText:'尚未送回'}).waitFor();
    assert.equal(await site.evaluate(()=>document.querySelector('[data-comic-studio]').shadowRoot.querySelector('input[type=file]')),null);
    assert(!(await importer.evaluate(()=>JSON.stringify(globalThis.sentImports))).includes('PRIVATE-SENTINEL'));report.checks.push('raw and extra JSON fields stay in extension import tab; invalid identity/regions/oversize rejected before submission');
    await importer.locator('#submit').click();await importer.getByRole('status').filter({hasText:'已匯入'}).waitFor();
    const sent=await importer.evaluate(()=>globalThis.sentImports.filter(m=>m.channel==='correction-import-submit'));assert.equal(sent.length,1);assert(!JSON.stringify(sent).includes('PRIVATE-SENTINEL'));
    await editor.getByLabel('選擇文字框',{exact:true}).selectOption('region-a');await editor.getByLabel('繁中譯文',{exact:true}).waitFor();assert.equal(await editor.getByLabel('繁中譯文',{exact:true}).inputValue(),'已匯入的校正');
    await editor.getByLabel('繁中譯文',{exact:true}).fill('人工校正相容性');
    const jsonDownload=site.waitForEvent('download');await editor.getByRole('button',{name:'匯出校正 JSON',exact:true}).click();const download=await jsonDownload;await download.saveAs(path.join(out,'export.json'));const exported=JSON.parse(await readFile(path.join(out,'export.json'),'utf8'));assert.equal(exported.regions[0].translation,'人工校正相容性');
    const pngDownload=site.waitForEvent('download');await editor.getByRole('button',{name:'匯出 PNG',exact:true}).click();await(await pngDownload).saveAs(path.join(out,'export.png'));
    await editor.getByRole('button',{name:'套用至漫畫頁',exact:true}).click();await site.waitForFunction(()=>document.querySelector('#comic').dataset.comicResult);
    await site.screenshot({path:path.join(out,'patched.png')});report.checks.push('valid deep-whitelisted correction import, manual edit, JSON/PNG export and apply-to-page remain functional');
    await editor.getByRole('button',{name:'關閉工作台',exact:true}).click();const rendered=await site.locator('#comic').getAttribute('src');await site.locator('#comic').dblclick();assert.notEqual(await site.locator('#comic').getAttribute('src'),rendered);await site.locator('#comic').dblclick();
    editor=await openEditor();const stale=await openImport();await stale.locator('#file').setInputFiles({name:'good.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(correction))});await stale.getByRole('status').filter({hasText:'尚未送回'}).waitFor();await editor.getByRole('button',{name:'關閉工作台',exact:true}).click();await stale.locator('#submit').click();await stale.getByRole('status').filter({hasText:'未自動重送'}).waitFor();
    editor=await openEditor();const changed=await openImport();await changed.locator('#file').setInputFiles({name:'good.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(correction))});await changed.getByRole('status').filter({hasText:'尚未送回'}).waitFor();await site.evaluate(()=>document.querySelector('#comic').src='https://cdn.fixture.test/1.png');await changed.locator('#submit').click();await changed.getByRole('status').filter({hasText:'未自動重送'}).waitFor();report.checks.push('closed editor and changed source image reject stale imports without retry');
    await editor.getByRole('button',{name:'關閉工作台',exact:true}).click();await site.reload();await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url?.startsWith('https://manga.fixture.test/'));await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content-scripts/content.js']});});
    await site.getByRole('button',{name:'翻譯本頁漫畫',exact:true}).click();await site.waitForFunction(()=>[...document.querySelectorAll('[data-comic-reader] img')].every(i=>i.dataset.comicResult));report.checks.push('chapter translation fixture and original/rendered toggles remain functional');
    await reader.getByLabel('選擇文字框',{exact:true}).selectOption('region-a');await reader.getByLabel('日文原文',{exact:true}).fill('キャンセルの動作検証');blockTranslation=true;
    const request=context.waitForEvent('request',{predicate:r=>new URL(r.url()).hostname==='translate.googleapis.com'});await reader.getByRole('button',{name:'3 翻譯繁中',exact:true}).click();await request;await reader.getByRole('button',{name:'取消',exact:true}).click();await heldTranslation?.abort().catch(()=>{});blockTranslation=false;
    await reader.getByRole('alert').filter({hasText:'已取消目前操作'}).waitFor();assert.equal(await reader.getByRole('button',{name:'3 翻譯繁中',exact:true}).isEnabled(),true);report.checks.push('cancel releases a pending fixture translation and restores editor controls');
    const probe=async url=>reader.evaluate(url=>chrome.runtime.sendMessage({channel:'fetch-image',url}),url);
    for(const [name,url]of [['public fixture','https://cdn.fixture.test/0.png'],['loopback DNS',`http://dns-loopback.fixture.test:${loopPort}/image.png`],...(privatePort?[['private DNS',`http://dns-private.fixture.test:${privatePort}/image.png`]]:[]),['redirect',`http://dns-loopback.fixture.test:${loopPort}/redirect`],['literal private','http://127.0.0.1/image.png']]){
      const result=await probe(url);report.dns.push({test:name,url,ok:result.ok,error:result.error,bytes:result.base64?.length});if(name==='public fixture')assert.equal(result.ok,true);if(name==='redirect'||name==='literal private')assert.equal(result.ok,false);
    }
    report.checks.push('DNS/private-network behavior observed with default browser security; production fetch policy unchanged');
  }
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));assert.equal(report.externalRequests.length,0,JSON.stringify(report.externalRequests));report.status='passed';
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;if(site)await site.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});if(importer)report.importStatus=await importer.locator('body').innerText().catch(()=>null);if(reader)report.readerStatus=await reader.locator('body').innerText().catch(()=>null);console.error(error);}
finally{await context?.close();for(const server of servers)await new Promise(resolve=>server.close(resolve));report.finished=new Date().toISOString();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
