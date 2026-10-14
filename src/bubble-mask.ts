import {fillMaskHoles} from './text-mask';
interface Rect {x:number;y:number;width:number;height:number}
// Prefer closed light interiors; panel-edge openings admit only small glyph
// holes so large outlines and surrounding artwork remain protected.
export function bubbleInterior(rgba:Uint8ClampedArray,width:number,height:number,region:Rect):Uint8Array|null {
  const bright=new Uint8Array(width*height),seen=new Uint8Array(bright.length),queue=new Int32Array(bright.length);
  for(let p=0;p<bright.length;p++)bright[p]=+(Math.min(rgba[p*4],rgba[p*4+1],rgba[p*4+2])>=235);
  let best:number[]|undefined,bestOverlap=0,open:number[]|undefined,openOverlap=0;
  for(let start=0;start<bright.length;start++){
    if(!bright[start]||seen[start])continue;
    let head=0,tail=1,border=false,overlap=0;queue[0]=start;seen[start]=1;
    while(head<tail){
      const p=queue[head++],x=p%width,y=Math.floor(p/width);
      border ||= x===0||y===0||x===width-1||y===height-1;
      if(x>=region.x&&x<region.x+region.width&&y>=region.y&&y<region.y+region.height)overlap++;
      for(const q of [x?p-1:-1,x<width-1?p+1:-1,y?p-width:-1,y<height-1?p+width:-1]){
        if(q>=0&&bright[q]&&!seen[q]){seen[q]=1;queue[tail++]=q;}
      }
    }
    if(!border&&overlap>bestOverlap&&overlap>=region.width*region.height*.2){bestOverlap=overlap;best=Array.from(queue.subarray(0,tail));}
    if(border&&overlap>openOverlap&&overlap>=region.width*region.height*.35){openOverlap=overlap;open=Array.from(queue.subarray(0,tail));}
  }
  if(!best&&!open)return null;
  const mask=new Uint8Array(bright.length);for(const p of (best??open)!)mask[p]=1;
  if(best)return fillMaskHoles(mask,width,height);
  // A balloon can be open at a panel/page edge. Keep the connected light area,
  // adding only small, surrounded glyph holes, never large outlines/artwork.
  const holesSeen=new Uint8Array(mask.length),glyphSide=Math.min(64,Math.max(12,Math.min(region.width,region.height)*.45));
  for(let start=0;start<mask.length;start++){
    if(mask[start]||holesSeen[start])continue;
    let head=0,tail=1,x0=width,x1=0,y0=height,y1=0,border=false;queue[0]=start;holesSeen[start]=1;
    while(head<tail){
      const p=queue[head++],x=p%width,y=Math.floor(p/width);
      x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
      border ||= x===0||y===0||x===width-1||y===height-1;
      for(const q of [x?p-1:-1,x<width-1?p+1:-1,y?p-width:-1,y<height-1?p+width:-1])if(q>=0&&!mask[q]&&!holesSeen[q]){holesSeen[q]=1;queue[tail++]=q;}
    }
    if(!border&&x1-x0<=glyphSide&&y1-y0<=glyphSide&&x1>=region.x&&x0<region.x+region.width&&y1>=region.y&&y0<region.y+region.height)for(let i=0;i<tail;i++)mask[queue[i]]=1;
  }
  return mask;
}
export function largestInteriorRect(mask:Uint8Array,width:number,height:number):Rect|null {
  const heights=new Int32Array(width);let best:Rect|null=null,area=0;
  for(let y=0;y<height;y++){
    for(let x=0;x<width;x++)heights[x]=mask[y*width+x]?heights[x]+1:0;
    const stack:number[]=[];
    for(let x=0;x<=width;x++){
      const h=x===width?0:heights[x];
      while(stack.length&&heights[stack[stack.length-1]]>h){
        const column=stack.pop()!,top=heights[column],left=stack.length?stack[stack.length-1]+1:0,w=x-left;
        if(w*top>area){area=w*top;best={x:left,y:y-top+1,width:w,height:top};}
      }
      stack.push(x);
    }
  }
  return best;
}
export function flatBackground(rgba:Uint8ClampedArray,width:number,height:number):boolean {
  const samples:number[]=[];
  const sample=(p:number)=>samples.push(rgba[p*4]*.299+rgba[p*4+1]*.587+rgba[p*4+2]*.114);
  for(let x=0;x<width;x++){sample(x);sample((height-1)*width+x);}
  for(let y=0;y<height;y++){sample(y*width);sample(y*width+width-1);}
  samples.sort((a,b)=>a-b);return samples[samples.length-1]-samples[0]<20;
}
