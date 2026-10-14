import {test} from 'node:test';import assert from 'node:assert/strict';
import {watchExtensionContext,onContextInvalidated,contextAlive} from '../src/extension-context';
test('a reloaded extension retires the stale page before another API call and stops its watcher',t=>{
  t.mock.timers.enable({apis:['setInterval']});let id:string|undefined='extension',reads=0,cleaned=0;
  (globalThis as any).chrome={runtime:{get id(){reads++;return id;}}};onContextInvalidated(()=>cleaned++);
  const stop=watchExtensionContext();t.mock.timers.tick(1000);assert(contextAlive());id=undefined;t.mock.timers.tick(1000);assert.equal(cleaned,1);assert(!contextAlive());
  t.mock.timers.tick(5000);assert.equal(reads,2);stop();delete (globalThis as any).chrome;
});
