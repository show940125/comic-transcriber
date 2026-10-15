import {test} from 'node:test';import assert from 'node:assert/strict';import {geminiProtocolPassed} from '../src/gemini-validation';
test('legacy unknown interruption can reuse local 30/30 proof without waiving protocol or HTTP failures',()=>{
 const proof={completed:30,total:30};assert.equal(geminiProtocolPassed({status:'blocked',error:'串流中斷或取消，結果未知'},proof),true);
 for(const validation of [undefined,{status:'blocked',error:'匿名頁未提供協定版本'},{status:'blocked',error:'HTTP 403 結果未知'}])assert.equal(geminiProtocolPassed(validation,proof),false);
 assert.equal(geminiProtocolPassed({status:'blocked',error:'結果未知'},{completed:29,total:30}),false);assert.equal(geminiProtocolPassed({status:'passed'}),true);
});
