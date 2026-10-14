import {test} from 'node:test';import assert from 'node:assert/strict';
import {bubbleInterior,largestInteriorRect,flatBackground} from '../src/bubble-mask';
const image=(w:number,h:number,v:number)=>{const a=new Uint8ClampedArray(w*h*4);for(let p=0;p<w*h;p++){a[p*4]=a[p*4+1]=a[p*4+2]=v;a[p*4+3]=255;}return a;};
test('closed bubble retains outline and outside artwork while including text holes',()=>{
  const w=40,h=30,a=image(w,h,180);for(let y=5;y<25;y++)for(let x=8;x<32;x++)for(let c=0;c<3;c++)a[(y*w+x)*4+c]=255;
  for(let c=0;c<3;c++)a[(15*w+20)*4+c]=0;
  const mask=bubbleInterior(a,w,h,{x:2,y:2,width:36,height:26})!;assert(mask);assert.equal(mask[15*w+20],1);assert.equal(mask[4*w+20],0);assert.equal(mask[15*w+7],0);
});
test('open light region admits small glyph holes while retaining large artwork and outlines',()=>{
  const w=60,h=50,a=image(w,h,255);for(let y=10;y<40;y++)for(let x=5;x<30;x++)for(let c=0;c<3;c++)a[(y*w+x)*4+c]=0;for(let c=0;c<3;c++)a[(20*w+43)*4+c]=0;
  const mask=bubbleInterior(a,w,h,{x:3,y:3,width:54,height:44})!;assert(mask);assert.equal(mask[20*w+43],1);assert.equal(mask[20*w+20],0);assert.equal(mask[0],1);
});
test('largest layout rectangle stays entirely inside a curved bubble mask',()=>{
  const w=30,h=30,mask=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)mask[y*w+x]=+((x-15)**2+(y-15)**2<12**2);
  const rect=largestInteriorRect(mask,w,h)!;assert(rect.width>10&&rect.height>10);for(let y=rect.y;y<rect.y+rect.height;y++)for(let x=rect.x;x<rect.x+rect.width;x++)assert.equal(mask[y*w+x],1);
});
test('mixed artwork borders are not safe for automatic colour propagation',()=>{
  const a=image(20,20,180);assert.equal(flatBackground(a,20,20),true);for(let p=0;p<20;p++)for(let c=0;c<3;c++)a[p*4+c]=p<10?0:255;assert.equal(flatBackground(a,20,20),false);
});
test('even a thin contour crossing the crop boundary disables flat-background repair',()=>{
  const a=image(30,30,255);for(let c=0;c<3;c++)a[10*4+c]=0;assert.equal(flatBackground(a,30,30),false);
});
test('panel-edge balloon admits tall anchored lettering instead of reducing layout to a side strip',()=>{
  const w=90,h=150,a=image(w,h,255),r={x:30,y:15,width:30,height:120};
  for(let y=20;y<120;y++)for(let x=37;x<53;x++)for(let c=0;c<3;c++)a[(y*w+x)*4+c]=0;
  const mask=bubbleInterior(a,w,h,r)!;assert(mask);assert.equal(mask[70*w+45],1);
  const crop=new Uint8Array(r.width*r.height);for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++)crop[y*r.width+x]=mask[(r.y+y)*w+r.x+x];
  assert.equal(largestInteriorRect(crop,r.width,r.height)?.width,30);
});
test('a large white counter inside a Japanese square glyph is not mistaken for the speech balloon',()=>{
  const w=90,h=90,a=image(w,h,180);
  for(let y=10;y<80;y++)for(let x=10;x<80;x++)for(let c=0;c<3;c++)a[(y*w+x)*4+c]=255;
  for(let y=32;y<59;y++)for(let x=32;x<59;x++)if(x<35||x>55||y<35||y>55)for(let c=0;c<3;c++)a[(y*w+x)*4+c]=0;
  const mask=bubbleInterior(a,w,h,{x:29,y:29,width:32,height:32})!;assert.equal(mask[44*w+33],1);assert.equal(mask[44*w+9],0);
});
