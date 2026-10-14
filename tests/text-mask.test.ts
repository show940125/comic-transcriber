import {test} from 'node:test';
import assert from 'node:assert/strict';
import {glyphBackingMask,dilateMask,fillMaskHoles,sourceInkMask,repairTextBackground} from '../src/text-mask';
const pixels=(w:number,h:number,value:number,alpha=255)=>{const data=new Uint8ClampedArray(w*h*4);for(let p=0;p<w*h;p++){data[p*4]=data[p*4+1]=data[p*4+2]=value;data[p*4+3]=alpha;}return data;};
test('anchored connected Japanese at a crop boundary is erased while an independent contour stays untouched',()=>{
  const w=48,h=120,data=pixels(w,h,255),interior=new Uint8Array(w*h).fill(1);
  for(let y=8;y<108;y++)for(let x=18;x<28;x++)for(let c=0;c<3;c++)data[(y*w+x)*4+c]=0;
  for(let y=0;y<h;y++)for(let c=0;c<3;c++)data[(y*w+2)*4+c]=0;
  const mask=sourceInkMask(data,w,h,{textBounds:{x:16,y:8,width:14,height:100},interior});
  assert.equal(mask.reduce((sum,v)=>sum+v,0),1000);assert.equal(mask[40*w+2],0);
  const repaired=repairTextBackground(data,mask,w,h);assert.equal(repaired[(40*w+22)*4],255);assert.equal(repaired[(40*w+2)*4],0);
});
test('round backing expands glyph edges while leaving diagonal corners unchanged',()=>{
  const mask=new Uint8Array(49);mask[24]=1;const result=dilateMask(mask,7,7,2);assert.equal(result[3*7+1],1);assert.equal(result[1*7+1],0);assert.equal(result[0],0);
});
test('enclosed counters receive opaque backing, open background remains outside',()=>{
  const mask=new Uint8Array([0,0,0,0,0,0,1,1,1,0,0,1,0,1,0,0,1,1,1,0,0,0,0,0,0]);const filled=fillMaskHoles(mask,5,5);assert.equal(filled[12],1);assert.equal(filled[0],0);assert.equal(filled[24],0);
});
test('source text outside a shorter translation remains covered; unrelated empty area is preserved',()=>{
  const w=30,h=20,source=pixels(w,h,255),glyph=pixels(w,h,0,0);source[(5*w+3)*4]=source[(5*w+3)*4+1]=source[(5*w+3)*4+2]=0;glyph[(12*w+21)*4+3]=255;
  const erase=dilateMask(sourceInkMask(source,w,h),w,h,2),mask=glyphBackingMask(glyph,w,h,2);assert.equal(erase[5*w+3],1);assert.equal(mask[12*w+21],1);assert.equal(mask[19*w+29],0);assert.equal(mask[0],0);assert.equal(mask[5*w+3],0);assert(mask.reduce((a,b)=>a+b,0)<w*h/4);
});
test('source mask finds both dark Japanese on paper and white Japanese on dark backgrounds',()=>{
  const light=pixels(9,9,255),dark=pixels(9,9,0);for(let c=0;c<3;c++){light[40*4+c]=0;dark[40*4+c]=255;}assert.equal(sourceInkMask(light,9,9)[40],1);assert.equal(sourceInkMask(dark,9,9)[40],1);assert.equal(sourceInkMask(dark,9,9)[0],0);
});
test('local colour repair erases source ink without a white Japanese silhouette or outside changes',()=>{
  const source=pixels(15,15,180);for(let y=5;y<10;y++)for(let x=5;x<10;x++)for(let c=0;c<3;c++)source[(y*15+x)*4+c]=0;
  const mask=dilateMask(sourceInkMask(source,15,15),15,15,2),result=repairTextBackground(source,mask,15,15);
  for(let p=0;p<225;p++){assert.equal(result[p*4],180);assert.equal(result[p*4+3],255);}assert.deepEqual(result.slice(0,4),source.slice(0,4));
});
test('source segmentation retains long boundary-connected comic contours',()=>{
  const source=pixels(30,30,255);for(let y=0;y<30;y++)for(let c=0;c<3;c++)source[(y*30+3)*4+c]=0;for(let c=0;c<3;c++)source[(15*30+15)*4+c]=0;
  const mask=sourceInkMask(source,30,30);assert.equal(mask[15*30+3],0);assert.equal(mask[15*30+15],1);
});
