import {test} from 'node:test';import assert from 'node:assert/strict';
import {defaults,type Region,type PageData} from '../src/types';
import {contentSignature,prompt,translationInstructions} from '../src/core';
import {refinementInput,refinementContext,refineChapter} from '../src/chapter-refinement';
import {geminiTranslate} from '../src/gemini-web';
import {settings,saveSettings} from '../src/storage';
const region:Region={id:'bubble',x:0,y:0,width:100,height:100,order:0,source:'兄さん、待って！',translation:'哥哥，等等！',score:1,warnings:[],kind:'bubble',render:'auto'};
const page:PageData={schema:1,hash:'page',width:100,height:100,regions:[region],title:'',chapter:'',glossary:'',summary:'',modelKey:contentSignature(defaults)};
const custom={...defaults,title:'奇幻喜劇',translationInstructions:'主角語氣直率；長老使用正式語氣；兄さん統一為「哥哥」。',priorSummary:'主角與哥哥正在離開村落。'};

test('comic instructions reach the full-chapter prompt and preserve exact region mapping',async()=>{
 let calls=0;const result=await refineChapter([page],custom,undefined,undefined,async message=>{
  calls++;const input=JSON.parse(message.slice(message.indexOf('\n')+1));assert.equal(input.translationInstructions,custom.translationInstructions);assert.equal(input.priorSummary,custom.priorSummary);assert.equal(input.pages[0].regions[0].source,region.source);assert.match(message,/格式/);
  return {text:JSON.stringify([{id:input.pages[0].regions[0].id,text:'哥哥，等一下啦！'}]),raw:'fixture',build:'fixture'};
 });
 assert.equal(calls,1);assert.equal(result.pages[0].regions[0].translation,'哥哥，等一下啦！');assert.equal(result.pages[0].regions[0].initialTranslation,region.translation);assert.equal(page.regions[0].translation,region.translation);
});
test('local model and anonymous batch prompts carry bounded instructions without replacing fixed format rules',async()=>{
 const messages=prompt([region],custom,'');assert.equal(JSON.parse(messages[1].content).translationInstructions,custom.translationInstructions);assert.match(messages[0].content,/原ID保持不變/);
 const result=await geminiTranslate([{...region,translation:''}],custom,'hash',undefined,undefined,async message=>{
  const input=JSON.parse(message.slice(message.indexOf('\n')+1));assert.equal(input.translationInstructions,custom.translationInstructions);return {text:'[{"id":"bubble","text":"哥哥，等一下！"}]',raw:'fixture',build:'fixture'};
 });assert.equal(result[0].id,region.id);
 assert.equal(translationInstructions({...defaults,translationInstructions:'あ'.repeat(3001)}).length,3000);
 assert.equal(JSON.parse(refinementInput([page],{...custom,translationInstructions:'あ'.repeat(3001)}).payload).translationInstructions.length,3000);
});
test('instructions and prior summary invalidate refinement while Google/Chrome cache identities remain reusable',async()=>{
 assert.notEqual(await refinementContext(defaults),await refinementContext(custom));
 assert.notEqual(await refinementContext(defaults),await refinementContext({...defaults,translationInstructions:'少年語氣'}));
 assert.notEqual(await refinementContext(defaults),await refinementContext({...defaults,priorSummary:'前情'}));
 for(const backend of ['google-web','chrome'] as const)assert.equal(contentSignature({...defaults,backend}),contentSignature({...custom,backend}));
 for(const backend of ['local','webllm'] as const)assert.notEqual(contentSignature({...defaults,backend}),contentSignature({...defaults,backend,translationInstructions:custom.translationInstructions}));
 assert.equal(await refinementContext({...defaults,translationInstructions:'  稱呼哥哥  '}),await refinementContext({...defaults,translationInstructions:'稱呼哥哥'}));
});
test('old settings default to empty instructions; saved text round-trips and oversized input is rejected',async()=>{
 let value:any={backend:'google-web',glossary:'葵＝小葵'};
 (globalThis as any).chrome={runtime:{id:'fixture'},storage:{local:{get:async()=>({settings:value}),set:async(data:any)=>{value=data.settings;}}}};
 try{
  const previous=await settings();assert.equal(previous.translationInstructions,'');assert.equal(previous.glossary,'葵＝小葵');
  await saveSettings({...previous,translationInstructions:'  少年語氣\n長老正式  '});assert.equal((await settings()).translationInstructions,'少年語氣\n長老正式');
  await assert.rejects(saveSettings({...previous,translationInstructions:'あ'.repeat(3001)}),/3,000/);assert.equal(value.translationInstructions,'少年語氣\n長老正式');
 }finally{delete (globalThis as any).chrome;}
});
