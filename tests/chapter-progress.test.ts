import test from 'node:test';
import assert from 'node:assert/strict';
import {ChapterProgress} from '../src/chapter-progress';

test('reports overlapping pages, deduplicates completions and keeps the run total',()=>{
  const run=new ChapterProgress('standard',2);
  run.update({phase:'ocr',status:'reused'},'existing',0);
  run.update({phase:'translate',status:'running'},'sending',0);
  run.update({phase:'ocr',status:'running'},'reading',1);
  run.update({phase:'ocr',status:'running'},'late signal',0);
  run.update({phase:'ocr',status:'done'},'outside snapshot',2);
  assert.deepEqual(run.rows().filter(row=>row.status==='running').map(row=>row.id),['ocr','translate']);
  assert.equal(run.rows()[1].summary,'1／2 張 · 沿用 1');
  assert.equal(run.isComplete('ocr'),false);
  run.update({phase:'ocr',status:'done'},'finished',1);
  assert.equal(run.isComplete('ocr'),true);
  assert.equal(run.isComplete('render'),false);
});

test('unknown and cancellation preserve achieved milestones without marking pending work complete',()=>{
  const run=new ChapterProgress('direct',2);
  for(let index=0;index<2;index++)run.update({phase:'ocr',status:'done'},'saved',index);
  run.update({phase:'gemini',status:'running'},'sent');
  run.finish('unknown');
  run.update({phase:'gemini',status:'done'},'late reply');
  const rows=run.rows();
  assert.equal(rows[1].status,'done');
  assert.equal(rows[2].status,'held');
  assert.equal(rows[2].summary,'待確認');
  assert.equal(rows[3].status,'pending');
  const cancelled=new ChapterProgress('standard',2);
  cancelled.update({phase:'render',status:'done'},'applied',0);
  cancelled.update({phase:'render',status:'running'},'encoding',1);
  cancelled.finish('cancelled');
  assert.equal(cancelled.rows().at(-1)?.summary,'1／2 張');
  assert.equal(cancelled.rows().at(-1)?.status,'held');
});
