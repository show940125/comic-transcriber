import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inkBounds } from '../src/detection';
test('diagonal contour fragments connect and are excluded from text mask', () => {
  const w=120,h=100,pixels=new Uint8ClampedArray(w*h*4).fill(255);
  const ink=(x:number,y:number)=>{for(let c=0;c<3;c++)pixels[(y*w+x)*4+c]=0;};
  for(let i=0;i<30;i++)for(let j=0;j<3;j++)ink(15+3*i+j,15+i);
  for(let y=60;y<70;y++)for(let x=50;x<70;x++)ink(x,y);
  assert.deepEqual(inkBounds(pixels,w,h),{x:47,y:57,width:26,height:16});
  for(let i=0;i<pixels.length;i++)if(i%4!==3)pixels[i]=255-pixels[i];
  assert.deepEqual(inkBounds(pixels,w,h),{x:47,y:57,width:26,height:16});
});
