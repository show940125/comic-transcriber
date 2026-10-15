import {test} from 'node:test';import assert from 'node:assert/strict';
import {allWebOrigins,requestAllWebAccess,specificSites} from '../src/site-access';

test('global website access never becomes an automatic translation wildcard',()=>{
 assert.deepEqual(specificSites([...allWebOrigins,'<all_urls>','https://*.example.com/*','https://%2A/*','https://%2a.example.com/*','https://manga.example/chapter','https://manga.example/*','https://manga.example/*','file:///tmp/*','https://user:pass@example.com/*']),['https://manga.example/*']);
 assert.deepEqual(specificSites(),[]);
});
test('restore-all requests both web schemes in the original user click stack',async()=>{
 let captured:unknown;const result=Promise.resolve(true);
 (globalThis as any).chrome={permissions:{request:(value:unknown)=>{captured=value;return result;}}};
 try{const grant=requestAllWebAccess();assert.deepEqual(captured,{origins:['http://*/*','https://*/*']});assert.equal(grant,result);assert.equal(await grant,true);}finally{delete (globalThis as any).chrome;}
});
