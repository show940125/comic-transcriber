import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleWebTranslate, parseGoogleWeb, GoogleHttpError } from '../src/google-web';
import type { Region } from '../src/types';
const region = (id: string, source = 'こんにちは'): Region => ({ id, source, translation: '', x:0,y:0,width:10,height:10,order:0,score:1,warnings:[],kind:'bubble',render:'auto' });
test('Google web chunks preserve order and normalize Taiwan text; malformed output fails', () => {
  assert.equal(parseGoogleWeb([[['这个',''],['软件很好。','']]]), '這個軟體很好。');
  for (const data of [null, {}, [], [[]], [[[null]]]]) assert.throws(() => parseGoogleWeb(data));
});
test('anonymous web adapter reuses duplicates, preserves IDs and sends only text', async () => {
  const calls: URL[] = [];
  const transport = (async (input: URL, init: RequestInit) => { calls.push(input);assert.equal(init.credentials,'omit');assert.equal(init.body,undefined);assert.equal(input.hostname,'translate.googleapis.com');assert.equal(input.searchParams.get('tl'),'zh-TW');assert.equal(input.searchParams.has('key'),false);return new Response(JSON.stringify([[['你好','こんにちは']]])); }) as typeof fetch;
  const before=[region('a'),region('b'),region('empty','')],result=await googleWebTranslate(before,undefined,undefined,transport);
  assert.equal(calls.length,1);assert.deepEqual(result.map(r=>[r.id,r.translation]),[['a','你好'],['b','你好'],['empty','']]);assert.equal(before[0].translation,'');
});
test('rate limit stops immediately without retries or partial application', async () => {
  let calls=0;const transport=(async()=>{calls++;return new Response('',{status:429});}) as typeof fetch;
  await assert.rejects(googleWebTranslate([region('a'),region('b')],undefined,undefined,transport),/429/);assert.equal(calls,1);
  const abort=new AbortController();abort.abort();await assert.rejects(googleWebTranslate([region('a')],undefined,abort.signal,transport));assert.equal(calls,1);
});

test('only actual transient HTTP errors receive bounded retry and recorded status',async()=>{
  let calls=0;const diagnostics:any[]=[];
  const transport=(async()=>{calls++;return calls===1?new Response('',{status:500}):new Response(JSON.stringify([[['成功']]]));}) as typeof fetch;
  const result=await googleWebTranslate([region('a')],d=>diagnostics.push(d),undefined,transport,{retryDelays:[0,0],spacingMs:0});
  assert.equal(result[0].translation,'成功');assert.equal(calls,2);assert.equal(diagnostics[1].httpStatus,500);assert.equal(diagnostics[1].cause,'http');
  for(const status of [403,429]){calls=0;await assert.rejects(googleWebTranslate([region('a')],undefined,undefined,(async()=>{calls++;return new Response('',{status});}) as typeof fetch,{retryDelays:[0,0]}),e=>e instanceof GoogleHttpError&&e.status===status);assert.equal(calls,1);}
});

test('persistent 500 preserves completed dialogue and resume sends only remaining text',async()=>{
  let partial:Region[]=[];const sources:string[]=[];
  const transport=(async input=>{const source=new URL(String(input)).searchParams.get('q')!;sources.push(source);return source==='最初'?new Response(JSON.stringify([[['第一句']]])):new Response('',{status:500});}) as typeof fetch;
  await assert.rejects(googleWebTranslate([region('a','最初'),region('b','次')],undefined,undefined,transport,{retryDelays:[0,0],spacingMs:0,onPartial:async rows=>{partial=rows;}}),e=>e instanceof GoogleHttpError&&e.attempts===3);
  assert.equal(partial[0].translation,'第一句');assert.equal(partial[1].translation,'');assert.deepEqual(sources,['最初','次','次','次']);
  sources.length=0;const result=await googleWebTranslate(partial,undefined,undefined,(async input=>{sources.push(new URL(String(input)).searchParams.get('q')!);return new Response(JSON.stringify([[['第二句']]]));}) as typeof fetch,{spacingMs:0});
  assert.deepEqual(sources,['次']);assert.deepEqual(result.map(r=>r.translation),['第一句','第二句']);
});

test('cancellation while waiting after 500 remains AbortError and triggers no further request',async()=>{
  const abort=new AbortController();let calls=0;
  await assert.rejects(googleWebTranslate([region('a')],d=>{if(d.httpStatus)abort.abort(new DOMException('已取消','AbortError'));},abort.signal,(async()=>{calls++;return new Response('',{status:500});}) as typeof fetch,{retryDelays:[2000,5000]}),e=>e instanceof DOMException&&e.name==='AbortError'&&!(e instanceof GoogleHttpError));
  assert.equal(calls,1);
});

test('connection failure carries no invented HTTP status and does not retry',async()=>{
  let calls=0;await assert.rejects(googleWebTranslate([region('a')],undefined,undefined,(async()=>{calls++;throw new TypeError('Failed to fetch');}) as typeof fetch),e=>e instanceof TypeError&&!('status' in e));assert.equal(calls,1);
});
