import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingOrder, clampRegion, detectorBox, parseTranslations, localUrl, contentSignature, compatiblePageKey, iou, publicImageUrl, importCorrection } from '../src/core';
import { defaults, type Region } from '../src/types';
import { traditional } from '../src/language';
import { imageBase64, imageBytes } from '../src/binary';
const region = (id: string, x = 0, y = 0): Region => ({ id, x, y, width: 100, height: 100, order: 0, source: 'こんにちは', translation: '', score: 1, warnings: [], kind: 'bubble', render: 'auto' });
test('manga reading order groups rows right-to-left', () => { assert.deepEqual(readingOrder([region('left', 0, 0), region('bottom', 100, 300), region('right', 300, 10)]).map(r => r.id), ['right','left','bottom']); });
test('edited boxes cannot escape original dimensions', () => { assert.deepEqual(clampRegion({ ...region('a'), x: -20, y: 900, width: 1000 }, 400, 500), { ...region('a'), x:0, y:499, width:400, height:1 }); });
test('off-page detector corners are clipped without expanding the surviving text crop',()=>{assert.deepEqual(detectorBox([-20,10,30,80],100,100),{x:0,y:10,width:30,height:70});assert.equal(detectorBox([120,10,130,80],100,100),null);assert.equal(detectorBox([NaN,0,10,10],100,100),null);});
test('translation IDs must be exact, unique and complete', () => {
  const rows = [region('a'),region('b')];
  assert.equal(parseTranslations('[{"id":"b","text":"你好"},{"id":"a","text":"午安"}]', rows).get('a'),'午安');
  for (const text of ['[]','[{"id":"a","text":"甲"},{"id":"a","text":"乙"}]','[{"id":"a","text":"甲"},{"id":"c","text":"乙"}]','[{"id":"a","text":""},{"id":"b","text":"乙"}]']) assert.throws(() => parseTranslations(text,rows));
});
test('WebLLM empty thinking control prefix is removed; real reasoning remains rejected', () => { const r=[region('a')];assert.equal(parseTranslations('<think>\n\n</think>\n\n[{"id":"a","text":"你好"}]',r).get('a'),'你好');assert.throws(()=>parseTranslations('<think>reasoning</think>[{"id":"a","text":"你好"}]',r)); });
test('local service URL rejects external destinations and credentials', () => { assert.equal(localUrl('http://127.0.0.1:8080/v1/'),'http://127.0.0.1:8080/v1'); for (const url of ['https://example.com','http://127.0.0.1.evil.test','http://user:pass@localhost','file:///a','http://localhost/?secret=x']) assert.throws(() => localUrl(url)); });
test('LLM cache identity follows every translation context change', () => { const config={...defaults,backend:'local' as const};for (const key of ['glossary','priorSummary','chapter','localModel'] as const) assert.notEqual(contentSignature(config),contentSignature({ ...config,[key]:'new' })); });
test('Google and Chrome caches ignore unused story context while OCR/provider changes still invalidate',()=>{for(const backend of ['google-web','chrome'] as const){const config={...defaults,backend};assert.equal(contentSignature(config),contentSignature({...config,title:'作品',chapter:'2',glossary:'角色',priorSummary:'前頁'}));assert.notEqual(contentSignature(config),contentSignature({...config,ocrProvider:config.ocrProvider==='wasm'?'auto':'wasm'}));}const current=contentSignature(defaults),legacy=JSON.parse(current);legacy[12]='上一頁的譯文';assert(compatiblePageKey(JSON.stringify(legacy),current));legacy[8]='auto';assert(!compatiblePageKey(JSON.stringify(legacy),current));assert(!compatiblePageKey('invalid',current));});
test('non-overlapping regions have zero IoU', () => { assert.equal(iou(region('a'),region('b',200,0)),0); assert.equal(iou(region('a'),region('b')),1); });
test('translation output normalizes Simplified Chinese and Taiwan software terminology',()=>{assert.equal(traditional('这个软件很好。'),'這個軟體很好。');});
test('generic image proxy excludes local inference endpoints and normalized private IPs',()=>{assert.equal(publicImageUrl('https://example.com/a.png').hostname,'example.com');for(const url of ['http://127.1/a','http://2130706433/a','http://169.254.169.254/a','http://[::1]/a','http://192.168.1.1/a','http://u:p@example.com/a'])assert.throws(()=>publicImageUrl(url));});
test('correction import binds identity and refuses duplicate/outside boxes',()=>{const page={schema:1,hash:'abc',width:100,height:100,regions:[region('a')]};assert.equal(importCorrection(page,'abc',100,100).length,1);assert.throws(()=>importCorrection(page,'other',100,100));assert.throws(()=>importCorrection({...page,regions:[region('a'),region('a')]},'abc',100,100));assert.throws(()=>importCorrection({...page,regions:[region('a',99)]},'abc',100,100));});

test('binary image messaging round-trips arbitrary bytes across chunk boundaries',()=>{const bytes=Uint8Array.from({length:20000},(_,i)=>i%256);assert.deepEqual(imageBytes(imageBase64(bytes)),bytes);assert.throws(()=>imageBytes('%%%'));assert(4*Math.ceil(20*1024*1024/3)<64*1024*1024,'20 MB image payload stays below Chrome JSON message limit');});
