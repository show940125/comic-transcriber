import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGpuProbe} from '../src/gpu';
test('GPU probe is lazy, passes no powerPreference, and shares concurrent successful requests',async()=>{
  let calls=0;const probe=createGpuProbe(()=>({requestAdapter:async(...args:unknown[])=>{calls++;assert.equal(args.length,0);return {features:new Set(['shader-f16']),info:{vendor:'fixture',architecture:'test',device:'1',description:'test adapter'},limits:{maxBufferSize:1024,maxStorageBufferBindingSize:512}};}} as unknown as GPU));
  assert.equal(calls,0);const [a,b]=await Promise.all([probe(),probe()]);assert.equal(calls,1);assert.equal(a,b);assert.equal(a.f16,true);assert.equal(a.info?.vendor,'fixture');
});
test('no adapter is an ordinary cached fallback; explicit recheck can recover',async()=>{
  let calls=0;const probe=createGpuProbe(()=>({requestAdapter:async()=>{calls++;return calls===1?null:{features:new Set(),info:{vendor:'recovered'},limits:{}};}} as unknown as GPU));
  assert.equal((await probe()).available,false);assert.equal((await probe()).available,false);assert.equal(calls,1);assert.equal((await probe(true)).available,true);assert.equal(calls,2);
});
test('missing GPU API and request failure retain diagnostic reasons without breaking WASM',async()=>{
  assert.match((await createGpuProbe(()=>undefined)()).reason!,/未提供 WebGPU/);
  const probe=createGpuProbe(()=>({requestAdapter:async()=>{throw Error('device unavailable');}} as unknown as GPU));
  assert.match((await probe()).reason!,/device unavailable/);assert.equal((await probe()).available,false);
});
