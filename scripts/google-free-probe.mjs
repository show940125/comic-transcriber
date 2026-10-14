import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testProfile, freshWorker } from './harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = { schema: 1, checkedAt: new Date().toISOString(), billing: 'no key, credentials or Cloud billing used', web: [], builtin: {} };
// Two original test sentences only. No retry or attempts to bypass rate limits.
for (const source of ['今日はいい天気だね。', '一緒に帰ろう。']) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.search = new URLSearchParams({ client: 'gtx', sl: 'ja', tl: 'zh-TW', dt: 't', q: source }).toString();
  const start = performance.now();
  try {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    const text = Array.isArray(data[0]) ? data[0].map(row => row[0] ?? '').join('') : '';
    result.web.push({ source, status: response.status, text, ms: performance.now() - start, endpoint: url.origin + url.pathname });
    if (!response.ok || !text) break;
  } catch (error) { result.web.push({ source, error: String(error), ms: performance.now() - start }); break; }
}
const ext = path.join(root, '.output/chrome-mv3');
const context = await chromium.launchPersistentContext(await testProfile(root, 'chrome-translator'), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
try {
  const worker = await freshWorker(context), id = worker.url().split('/')[2], page = await context.newPage();
  await page.goto(`chrome-extension://${id}/reader.html`);
  result.builtin = await page.evaluate(async () => ({
    userAgent: navigator.userAgent, exposed: 'Translator' in self,
    availability: 'Translator' in self ? await Translator.availability({ sourceLanguage: 'ja', targetLanguage: 'zh-Hant' }) : 'API absent'
  }));
} catch (error) { result.builtin.error = String(error); }
finally { await context.close(); }
await writeFile(path.join(root, 'artifacts/google-free-probe.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
