import {test} from 'node:test';import assert from 'node:assert/strict';
import {extensionCall,detached,onContextInvalidated,contextAlive,ExtensionContextError} from '../src/extension-context';
test('context invalidation settles synchronous and asynchronous failures, cleans up once, and blocks later API calls',async()=>{
  let cleaned=0,calls=0,unexpected=0;onContextInvalidated(()=>cleaned++);
  await assert.rejects(extensionCall(()=>{throw new Error('ordinary storage failure');}),/ordinary/);assert(contextAlive());
  detached(()=>Promise.reject(new Error('ordinary detached failure')),()=>unexpected++);await new Promise(setImmediate);assert.equal(unexpected,1);
  await assert.rejects(extensionCall(()=>{calls++;throw new Error('Extension context invalidated.');}),ExtensionContextError);
  detached(()=>{calls++;return Promise.reject(new Error('Extension context invalidated.'));});await new Promise(setImmediate);
  assert.equal(cleaned,1);assert.equal(calls,1);assert(!contextAlive());
});
