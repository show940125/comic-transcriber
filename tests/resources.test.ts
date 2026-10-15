import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IdleRuntime,resolveThreads} from '../src/idle-runtime';
import {clampDock} from '../src/dock-position';
import {OrderedTurns} from '../src/scheduling';
import {responseBytes,inventory,scanCaches,removeCache,recordKey} from '../src/cache-inventory';
test('idle release waits for all activity, resets on new work and stops after disposal',t=>{
 t.mock.timers.enable({apis:['setTimeout']});let released=0;const idle=new IdleRuntime(()=>released++);
 idle.activity(0);t.mock.timers.tick(59000);assert.equal(released,0);idle.activity(2);t.mock.timers.tick(120000);assert.equal(released,0);
 idle.activity(0);t.mock.timers.tick(59999);assert.equal(released,0);idle.activity(1);idle.activity(0);t.mock.timers.tick(60000);assert.equal(released,1);
 idle.activity(0);idle.dispose();t.mock.timers.tick(60000);assert.equal(released,1);
});
test('thread selection needs both isolation and shared memory; auto retains baseline',()=>{
 assert.equal(resolveThreads('auto',true,true).threads,1);assert.equal(resolveThreads(4,true,true).threads,4);
 assert.equal(resolveThreads(2,false,true).threads,1);assert(resolveThreads(4,true,false).reason);
 assert.equal(resolveThreads(99 as any,true,true).threads,1);
});
test('dock stays reachable on small viewports and after a resize',()=>{
 assert.deepEqual(clampDock(1200,900,400,200,900,700),{x:496,y:496});assert.deepEqual(clampDock(-20,-30,400,200,200,150),{x:4,y:4});
});
test('context-sensitive translation preserves page order after OCR completes out of order',async()=>{
 const lane=new OrderedTurns(),events:number[]=[];const two=lane.wait(2).then(()=>events.push(2));const one=lane.wait(1).then(()=>events.push(1));
 await Promise.resolve();assert.deepEqual(events,[]);lane.finish(0);await one;assert.deepEqual(events,[1]);lane.finish(1);await two;assert.deepEqual(events,[1,2]);
 const abort=new AbortController(),pending=lane.wait(4,abort.signal);abort.abort();await assert.rejects(pending,{name:'AbortError'});
});
test('cache scan counts streamed payloads, keeps unknown separate and deletes only owned entries',async()=>{
 const values:Record<string,any>={'page:old':{hash:'abc',regions:[{}],modelKey:'["v","google-web"]'},pageKeys:['page:old']};
 const entries=new Map<string,Map<string,Uint8Array>>([['comic-vision-v1',new Map([['https://example.com/old',new Uint8Array(531)]])],['unrelated',new Map([['https://example.com/foreign',new Uint8Array(9)]])]]);
 (globalThis as any).chrome={storage:{local:{get:async(keys:any)=>keys===null?structuredClone(values):Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in values).map(k=>[k,structuredClone(values[k])])),getBytesInUse:async(keys:any)=>JSON.stringify(Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in values).map(k=>[k,values[k]]))).length,set:async(data:any)=>Object.assign(values,structuredClone(data)),remove:async(keys:string[])=>keys.forEach(k=>delete values[k])}}};
 (globalThis as any).caches={keys:async()=>[...entries.keys()],open:async(name:string)=>({keys:async()=>[...entries.get(name)!.keys()].map(url=>({url})),match:async(req:any)=>new Response(new Uint8Array(entries.get(name)!.get(req.url)!).buffer),delete:async(req:any)=>entries.get(name)!.delete(req.url)})};
 const prior=await inventory();assert.equal(prior.models[0].bytes,undefined);assert.equal(prior.unmeasured,1);assert.equal(prior.pages[0].savedAt,undefined);
 const measured=await scanCaches();assert.equal(measured.modelBytes,531);assert.equal(measured.unmeasured,0);
 await assert.rejects(removeCache({kind:'oops'} as any));assert.equal(entries.get('comic-vision-v1')!.size,1);
 await removeCache({kind:'models'});assert.equal(entries.get('comic-vision-v1')!.size,0);assert.equal(entries.get('unrelated')!.size,1);assert.equal(values.cacheSizeIndex[recordKey('comic-vision-v1','https://example.com/old')],undefined);
 await removeCache({kind:'page',key:'page:old'});assert.deepEqual(values.pageKeys,[]);
 delete (globalThis as any).chrome;delete (globalThis as any).caches;
});
test('streamed size measurement honours cancellation between chunks',async()=>{
 const abort=new AbortController();let cancelled=false;const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(13));abort.abort();},cancel(){cancelled=true;}});
 await assert.rejects(responseBytes(new Response(stream),abort.signal),{name:'AbortError'});assert(cancelled);
});
