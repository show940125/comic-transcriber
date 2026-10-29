import {chromium} from 'playwright';
import {readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=path.join(root,'artifacts/research-ocr');
const optimization=process.argv.includes('--optimization'),prefix=optimization?'optimization':'comparison';
const report={status:'running',pageErrors:[],filters:{},viewports:[]};let browser;
try{
 const file=path.join(out,prefix+'.html');report.htmlSha256=createHash('sha256').update(await readFile(file)).digest('hex');
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',error=>report.pageErrors.push(String(error)));
 await page.goto(pathToFileURL(file).href);await page.waitForLoadState('networkidle');assert.equal(await page.title(),optimization?'墨譯0.1.16 OCR優化驗收':'漫畫 OCR 研究比較');
 for(const [choice,expected] of [['real',149],['synthetic',300],['blank',30],['all',479]]){
  await page.locator('#dataset').selectOption(choice);const count=await page.locator('#comparison tbody tr:not([hidden])').count();assert.equal(count,expected);report.filters[choice]=count;
 }
 await page.locator('#mismatch').check();const mismatches=await page.locator('#comparison tbody tr:not([hidden])').count();assert(mismatches>0&&mismatches<479);report.filters.mismatches=mismatches;
 await page.locator('#mismatch').uncheck();await page.locator('#dataset').selectOption('real');await page.locator('#dataset').scrollIntoViewIfNeeded();
 const paths=await page.locator('img').evaluateAll(images=>images.map(image=>image.getAttribute('src')));for(const image of new Set(paths))await access(path.join(out,image));
 await page.screenshot({path:path.join(out,prefix+'-desktop.png')});report.viewports.push({width:1600,height:1000});
 await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForLoadState('networkidle');await page.locator('#dataset').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,prefix+'-mobile.png')});report.viewports.push({width:390,height:844});
 assert.equal(report.pageErrors.length,0);report.status='passed';report.imagesChecked=new Set(paths).size;
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;}
finally{await browser?.close();await writeFile(path.join(out,optimization?'optimization-ui-verification.json':'ui-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
