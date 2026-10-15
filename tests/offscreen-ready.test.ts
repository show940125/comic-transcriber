import {test} from 'node:test';import assert from 'node:assert/strict';
import {waitForOffscreenReady} from '../src/offscreen-ready';

test('only idempotent readiness probes retry while the receiver is starting',async()=>{
 let calls=0;await waitForOffscreenReady(async()=>{calls++;if(calls===1)throw Error('Could not establish connection. Receiving end does not exist.');return calls===2?undefined:{ok:true,ready:true};},{timeoutMs:100,intervalMs:1});assert.equal(calls,3);
});
test('readiness has a deadline and unrelated runtime errors propagate immediately',async()=>{
 let calls=0;await assert.rejects(waitForOffscreenReady(async()=>{calls++;return undefined;},{timeoutMs:5,intervalMs:1}),/未能就緒/);assert(calls<20);
 calls=0;await assert.rejects(waitForOffscreenReady(async()=>{calls++;throw Error('Extension context invalidated.');}),/context invalidated/);assert.equal(calls,1);
});
test('an unanswered readiness probe cannot block the entire page indefinitely',async()=>{
 await assert.rejects(waitForOffscreenReady(()=>new Promise(()=>{}),{timeoutMs:5,intervalMs:1}),/未能就緒/);
});
