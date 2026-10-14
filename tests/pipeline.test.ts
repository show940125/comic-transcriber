import {test} from 'node:test';import assert from 'node:assert/strict';
import {processSession,type PageSession} from '../src/page-pipeline';
import {defaults} from '../src/types';
test('a queued page cannot submit another Google request after the first page receives 429',async()=>{
  const requests:string[]=[];(globalThis as any).chrome={runtime:{id:'fixture',sendMessage:async(message:any)=>{if(message.channel==='google-text'){requests.push(message.source);return {ok:true,status:429,data:null};}throw new Error('unexpected request '+message.channel);}}};
  const session=(source:string):PageSession=>({blob:new Blob([]),image:{naturalWidth:100,naturalHeight:100} as HTMLImageElement,hash:'a'.repeat(64),modelKey:'',config:{...defaults},regions:[{id:source,x:0,y:0,width:50,height:50,order:0,source,translation:'',score:1,warnings:[],kind:'bubble',render:'auto',ocrDone:true}]});
  let failed=false;const hooks={canTranslate:()=>!failed,onFailure:()=>{failed=true;}};
  const outcomes=await Promise.allSettled([processSession(session('こんにちは'),hooks),processSession(session('さようなら'),hooks)]);
  assert.equal(outcomes[0].status,'rejected');assert.equal(outcomes[1].status,'rejected');assert.deepEqual(requests,['こんにちは']);
  if(outcomes[1].status==='rejected')assert.equal(outcomes[1].reason.name,'DeferredTranslationError');delete (globalThis as any).chrome;
});
