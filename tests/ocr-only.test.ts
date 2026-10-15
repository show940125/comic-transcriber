import {test} from 'node:test';import assert from 'node:assert/strict';
import {processSession,type PageSession} from '../src/page-pipeline';import {defaults} from '../src/types';
test('OCR-only chapter stage with cached Japanese issues zero Google or Gemini translation calls',async()=>{
 let requests=0;(globalThis as any).chrome={runtime:{sendMessage(){requests++;throw Error('unexpected translation');}}};
 const session={config:defaults,regions:[{id:'r',source:'待って',translation:'',ocrDone:true,needsReview:false}],metadata:{}} as unknown as PageSession;
 try{await processSession(session,{ocrOnly:true,beforeTranslate:async()=>{throw Error('translation gate must be skipped');}});assert.equal(requests,0);assert.equal(session.regions[0].translation,'');}
 finally{delete (globalThis as any).chrome;}
});
