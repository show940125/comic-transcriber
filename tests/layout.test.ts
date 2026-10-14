import {test} from 'node:test';import assert from 'node:assert/strict';
import {layoutText,verticalText} from '../src/text-layout';
import {importCorrection} from '../src/core';
const ctx={font:'',measureText(text:string){return {width:Array.from(text).length*parseFloat(this.font)} as TextMetrics;}};
test('a narrow vertical balloon keeps Chinese readable and columns right-to-left',()=>{
  const box={x:10,y:20,width:40,height:200},vertical=layoutText(ctx,'我們現在出發吧！',box),horizontal=layoutText(ctx,'我們現在出發吧！',box,'horizontal');
  assert.equal(vertical.direction,'vertical');assert(vertical.size>horizontal.size);assert(vertical.fits);assert(vertical.letters.every(p=>p.x>box.x&&p.x<box.x+box.width&&p.y>box.y&&p.y<box.y+box.height));
  const two=layoutText(ctx,'我們現在出發吧！一起往前走。',{x:0,y:0,width:100,height:170},'vertical');assert(two.letters[0].x>two.letters.at(-1)!.x);
});
test('horizontal dialogue and explicit direction survive, larger font never overflows',()=>{
  const box={x:0,y:0,width:260,height:80};assert.equal(layoutText(ctx,'這裡是我們的家。',box).direction,'horizontal');
  const small=layoutText(ctx,'這裡是我們的家。',box,'horizontal',.5),big=layoutText(ctx,'這裡是我們的家。',box,'horizontal',2);assert(big.size>small.size);assert(big.fits);
  assert.equal(verticalText('「什麼？！」'),'﹁什麼︖︕﹂');
});
test('correction round-trip retains independent OCR/bubble bounds and typography, rejects unsafe geometry',()=>{
  const region={id:'one',x:20,y:20,width:20,height:60,order:0,source:'そうだ',translation:'是的',kind:'bubble',render:'auto',warnings:[],ocrBox:{x:10,y:10,width:80,height:80},bubbleBox:{x:10,y:10,width:80,height:80},textDirection:'vertical',fontScale:1.2};
  const page={schema:1,hash:'fixture',width:100,height:100,regions:[region]},restored=importCorrection(page,'fixture',100,100)[0];assert.deepEqual(restored.bubbleBox,region.bubbleBox);assert.deepEqual(restored.ocrBox,region.ocrBox);assert.equal(restored.fontScale,1.2);assert.equal(restored.textDirection,'vertical');
  assert.throws(()=>importCorrection({...page,regions:[{...region,bubbleBox:{x:99,y:0,width:20,height:20}}]},'fixture',100,100),/範圍/);
});
