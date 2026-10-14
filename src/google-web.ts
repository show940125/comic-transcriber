import type { Diagnostic, Region } from './types';
import { traditional } from './language';
import { needsOcrReview,ocrReviewWarning } from './ocr-quality';

export const googleWebOrigin = 'https://translate.googleapis.com/*';
export class GoogleHttpError extends Error {
  readonly kind='http';
  constructor(readonly status:number,readonly regionId:string,readonly attempts:number){super(`Google 網頁翻譯實際回覆 HTTP ${status}（已請求 ${attempts} 次）；完成的對白已保留。`);}
}
export interface GoogleWebOptions { onPartial?:(regions:Region[])=>Promise<void>; retryDelays?:number[]; spacingMs?:number }
async function pause(ms:number,signal?:AbortSignal){
  signal?.throwIfAborted();if(!ms)return;
  await new Promise<void>((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,ms),abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason??new DOMException('已取消','AbortError'));};signal?.addEventListener('abort',abort,{once:true});});
}
export function parseGoogleWeb(data: unknown): string {
  if (!Array.isArray(data) || !Array.isArray(data[0]) || !data[0].length) throw new Error('Google 網頁翻譯回傳格式已改變');
  const pieces: string[] = [];
  for (const row of data[0]) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') throw new Error('Google 網頁翻譯回傳格式已改變');
    pieces.push(row[0]);
  }
  const output = pieces.join('').trim();
  if (!output || output.length > 1500) throw new Error('Google 譯文空白或超過長度限制');
  return traditional(output);
}

// Independently implemented anonymous web endpoint. No Cloud credentials/billing API.
// Sequential requests; bounded backoff for actual transient HTTP 5xx only.
export async function googleWebTranslate(regions: Region[], report: (d: Diagnostic) => void = () => {}, signal?: AbortSignal, transport: typeof fetch = fetch, options:GoogleWebOptions={}): Promise<Region[]> {
  const output = structuredClone(regions), cache = new Map<string, string>(), started = performance.now();
  for(const r of output)if(r.source.trim()&&r.translation.trim()&&!r.needsReview)cache.set(r.source.trim(),r.translation);
  const delays=(options.retryDelays??[2000,5000]).slice(0,2).map(n=>Math.max(0,Math.min(10000,n)));
  for (const [index, region] of output.entries()) {
    signal?.throwIfAborted();
    const source = region.source.trim();
    if(needsOcrReview(source)&&!region.needsReview){region.needsReview=true;region.warnings=[...(region.warnings??[]),ocrReviewWarning];}
    if (!source || region.needsReview) continue;
    if (source.length > 1500) throw new Error('單一文字框超過 1500 字，請先拆分');
    if(region.translation.trim())continue;
    report({ stage: 'translating', message: `Google 免金鑰網頁翻譯 ${index + 1}/${output.length}（只傳文字）`, backend: 'google-web/unofficial', model: 'Google web translation' });
    if (!cache.has(source)) {
      const url = new URL('https://translate.googleapis.com/translate_a/single');
      url.search = new URLSearchParams({ client: 'gtx', sl: 'ja', tl: 'zh-TW', dt: 't', q: source }).toString();
      for(let attempt=0;attempt<=delays.length;attempt++){
        const bounded=AbortSignal.timeout(15000),requestSignal=signal?AbortSignal.any([signal,bounded]):bounded;
        const response=await transport(url,{credentials:'omit',redirect:'error',signal:requestSignal});
        signal?.throwIfAborted();requestSignal.throwIfAborted();
        if(response.ok){cache.set(source,parseGoogleWeb(await response.json()));break;}
        const retry=[500,502,503,504].includes(response.status)&&attempt<delays.length;
        report({stage:retry?'translating':'error',message:retry?`第 ${index+1} 個對白實際收到 HTTP ${response.status}；等待 ${delays[attempt]/1000} 秒後重試（${attempt+1}/${delays.length}）`:`第 ${index+1} 個對白實際收到 HTTP ${response.status}，已保留完成部分`,backend:'google-web/unofficial',httpStatus:response.status,regionId:region.id,attempt:attempt+1,cause:'http'});
        if(!retry)throw new GoogleHttpError(response.status,region.id,attempt+1);
        await pause(delays[attempt],signal);
      }
      await pause(options.spacingMs??250,signal);
    }
    region.translation = cache.get(source)!;
    await options.onPartial?.(structuredClone(output));
  }
  report({ stage: 'complete', message: 'Google 網頁翻譯完成', backend: 'google-web/unofficial', model: 'Google web translation', ms: performance.now() - started });
  return output;
}
