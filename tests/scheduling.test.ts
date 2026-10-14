import {test} from 'node:test';import assert from 'node:assert/strict';
import {SerialLane,runPool,ResourceSlots} from '../src/scheduling';
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
test('hard cancellation settles all admitted work before releasing the pool',async()=>{
  const first=gate(),second=gate(),aborter=new AbortController();let settled=false;
  const run=runPool([0,1,2],2,async i=>{await (i===0?first:second).promise;},{stopped:()=>false,signal:aborter.signal});
  const checked=run.catch(error=>{settled=true;assert.equal(error.name,'AbortError');});
  await new Promise(setImmediate);aborter.abort();first.resolve();await new Promise(setImmediate);assert(!settled);
  second.resolve();await checked;assert(settled);
});
test('image slots bound two tabs globally, preserve FIFO, and free cancelled/closed-tab slots',async()=>{
  const slots=new ResourceSlots(2);await slots.acquire('a',1);await slots.acquire('b',2);let entered=false;
  const third=slots.acquire('c',2).then(()=>{entered=true;});await new Promise(setImmediate);assert(!entered);slots.release('a');await third;assert(entered);
  const fourth=slots.acquire('d',1);slots.release('d');await assert.rejects(fourth,{name:'AbortError'});
  let last=false;const fifth=slots.acquire('e',3).then(()=>{last=true;});slots.releaseOwner(2);await fifth;assert(last);
});
test('two in-flight pages overlap stages while the shared OCR lane stays serial',async()=>{
  const lane=new SerialLane(),ocr=gate(),translation=gate();let active=0,peak=0,ocrActive=0,ocrPeak=0;const entered:number[]=[];
  const run=runPool([0,1,2],2,async i=>{active++;peak=Math.max(peak,active);entered.push(i);await lane.run(async()=>{ocrActive++;ocrPeak=Math.max(ocrPeak,ocrActive);if(i===0)await ocr.promise;ocrActive--;});if(i===0)await translation.promise;active--;},{stopped:()=>false});
  await new Promise(setImmediate);assert.deepEqual(entered,[0,1]);ocr.resolve();await new Promise(setImmediate);assert(entered.includes(2));translation.resolve();await run;assert.equal(peak,2);assert.equal(ocrPeak,1);
});
test('soft stop drains two admitted pages, resume only takes pending pages',async()=>{
  const hold=gate();let stopped=false;const completed:number[]=[],admitted:number[]=[];
  const run=runPool([0,1,2,3],2,async i=>{admitted.push(i);await hold.promise;completed.push(i);},{stopped:()=>stopped});await new Promise(setImmediate);stopped=true;hold.resolve();await run;assert.deepEqual(admitted,[0,1]);assert.equal(completed.length,2);
  await runPool([2,3],2,async i=>{completed.push(i);},{stopped:()=>false});assert.deepEqual(completed.sort(),[0,1,2,3]);
});
test('failure stops admission and settles in-flight work; cancelled lane jobs never execute',async()=>{
  const hold=gate();let settled=false;const admitted:number[]=[];
  const run=runPool([0,1,2],2,async i=>{admitted.push(i);if(i===0)throw new Error('HTTP 429');await hold.promise;settled=true;},{stopped:()=>false});await new Promise(setImmediate);hold.resolve();await assert.rejects(run,/429/);assert(settled);assert.deepEqual(admitted,[0,1]);
  const lane=new SerialLane(),block=gate(),aborter=new AbortController();const first=lane.run(()=>block.promise);let executed=false;const cancelled=lane.run(async()=>{executed=true;},aborter.signal);aborter.abort();block.resolve();await first;await assert.rejects(cancelled,{name:'AbortError'});assert(!executed);
});
