import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {freshWorker, launchTestContext, testProfile} from './harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.resolve(root, process.env.COMIC_BUILD_DIR ?? '.output/chrome-mv3');
const channel = process.env.TEST_BROWSER ?? 'chromium';
const output = path.join(path.resolve(root, process.env.COMIC_POPUP_REPORT ?? 'artifacts/popup-regression'), channel);
const measureOnly = process.env.COMIC_POPUP_MEASURE_ONLY === '1';
const chapterUrl = 'https://moyu-popup.test/chapter';
const image = await readFile(path.join(root, 'artifacts/corpus/pages/page-01.png'));
const context = await launchTestContext(chromium, await testProfile(root, 'e2e'), {
  channel, headless: true,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
    '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server']
});
const report = {channel, status: 'running'};
await mkdir(output, {recursive: true});

try {
  const worker = await freshWorker(context);
  const base = new URL('.', worker.url());
  const inspector = await context.newPage();
  await inspector.goto(new URL('options.html', base).href);
  await context.route(chapterUrl, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><main data-comic-reader>' +
      '<img width="720" src="data:image/png;base64,' + image.toString('base64') + '" alt="原創漫畫"></main>'
  }));
  const site = await context.newPage();
  await site.goto(chapterUrl);
  await site.locator('main img').evaluate(img => img.decode());
  const activation = await inspector.evaluate(async url => {
    const [tab] = await chrome.tabs.query({url});
    return chrome.runtime.sendMessage({channel: 'activate-page', tabId: tab.id});
  }, chapterUrl);
  assert(activation?.ok, activation?.error);

  // The actual chrome.action popup auto-sizes from its document. A browser tab
  // serving the same HTML has a pre-sized viewport and misses this regression.
  await worker.evaluate(() => chrome.action.openPopup());
  await inspector.waitForFunction(() => {
    const [popup] = chrome.extension.getViews({type: 'popup'});
    return popup?.innerWidth > 0 && popup.document.getElementById('tab-state')?.textContent.includes('已啟用');
  });
  report.dimensions = await inspector.evaluate(() => {
    const [popup] = chrome.extension.getViews({type: 'popup'});
    const {body, documentElement} = popup.document;
    return {
      version: chrome.runtime.getManifest().version,
      viewportWidth: popup.innerWidth,
      bodyWidth: body.getBoundingClientRect().width,
      viewportHeight: popup.innerHeight,
      contentHeight: body.scrollHeight,
      horizontalOverflow: documentElement.scrollWidth - documentElement.clientWidth
    };
  });
  if (!measureOnly) {
    assert(report.dimensions.bodyWidth >= 320 && report.dimensions.viewportWidth >= 320);
    assert(report.dimensions.horizontalOverflow <= 1);
    assert(report.dimensions.contentHeight <= report.dimensions.viewportHeight + 1);
    const focused = await inspector.evaluate(() => {
      const [popup] = chrome.extension.getViews({type: 'popup'});
      const reader = popup.document.getElementById('reader');
      reader.focus();
      reader.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
      return popup.document.activeElement.id;
    });
    assert.equal(focused, 'settings');

    await inspector.evaluate(() => {
      const [popup] = chrome.extension.getViews({type: 'popup'});
      popup.document.querySelector('summary').click();
      popup.document.getElementById('visibility').click();
    });
    await inspector.waitForFunction(() => {
      const [popup] = chrome.extension.getViews({type: 'popup'});
      return popup?.document.getElementById('primary')?.textContent === '顯示工具列';
    });
    await inspector.evaluate(() => {
      const [popup] = chrome.extension.getViews({type: 'popup'});
      popup.document.getElementById('primary').click();
    });
    await inspector.waitForFunction(() => {
      const [popup] = chrome.extension.getViews({type: 'popup'});
      return popup?.document.querySelector('.tab-card').dataset.state === 'visible';
    });
    report.checked = ['native popup sizing', 'toolbar arrow focus', 'hide and restore tools'];
  }

  // Capture the shipped document at the native popup's measured dimensions.
  const screenshot = await context.newPage();
  await screenshot.setViewportSize({
    width: report.dimensions.viewportWidth,
    height: report.dimensions.viewportHeight
  });
  await site.bringToFront();
  await screenshot.goto(new URL('popup.html', base).href);
  await screenshot.getByText('本頁墨譯已啟用，可從漫畫頁開始翻譯。', {exact: true}).waitFor();
  await screenshot.screenshot({path: path.join(output, 'popup.png')});
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
