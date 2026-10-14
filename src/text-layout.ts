import type {Region,Rect} from './types';
export type TextDirection='horizontal'|'vertical';
export interface Letter {text:string;x:number;y:number}
export interface TextLayout {direction:TextDirection;size:number;letters:Letter[];fits:boolean}
const punctuation:Record<string,string>={'，':'︐','、':'︑','。':'︒','：':'︓','；':'︔','！':'︕','？':'︖','…':'︙','（':'︵','）':'︶','「':'﹁','」':'﹂','『':'﹃','』':'﹄','—':'︱'};
export const verticalText=(text:string)=>Array.from(text).map(c=>punctuation[c]??c).join('');
export function horizontalLines(text:string,width:number,measure:(s:string)=>number){
  const lines:string[]=[];let line='';
  for(const char of text){if(char==='\n'){lines.push(line);line='';continue;}if(line&&measure(line+char)>width){lines.push(line);line=char;}else line+=char;}
  if(line)lines.push(line);return lines;
}
export function layoutText(ctx:Pick<CanvasRenderingContext2D,'font'|'measureText'>,text:string,box:Rect,direction:Region['textDirection']='auto',scale=1):TextLayout{
  const pad=Math.min(6,box.width*.06,box.height*.06),w=Math.max(1,box.width-pad*2),h=Math.max(1,box.height-pad*2);
  const make=(orientation:TextDirection,size:number):TextLayout=>{
    ctx.font=`${size}px "ComicTC", "Microsoft JhengHei", sans-serif`;
    if(orientation==='horizontal'){
      const lines=horizontalLines(text,w,s=>ctx.measureText(s).width),lh=size*1.25;
      const fits=lines.length*lh<=h&&lines.every(s=>ctx.measureText(s).width<=w);
      return {direction:orientation,size,fits,letters:lines.map((s,i)=>({text:s,x:box.x+box.width/2,y:box.y+(box.height-lines.length*lh)/2+(i+.5)*lh}))};
    }
    const rows=Math.max(1,Math.floor(h/(size*1.15))),columns:string[][]=[[]];
    for(const char of verticalText(text)){if(char==='\n'||columns.at(-1)!.length===rows){columns.push([]);if(char==='\n')continue;}columns.at(-1)!.push(char);}
    if(!columns.at(-1)!.length)columns.pop();
    const cw=size*1.15,used=columns.length*cw,fit=used<=w&&size*1.15<=h&&columns.every(c=>c.every(s=>ctx.measureText(s).width<=cw));
    const letters=columns.flatMap((column,c)=>column.map((s,i)=>({text:s,x:box.x+(box.width+used)/2-(c+.5)*cw,y:box.y+(box.height-column.length*size*1.15)/2+(i+.5)*size*1.15})));
    return {direction:orientation,size,fits:fit,letters};
  };
  const fit=(d:TextDirection)=>{for(let size=Math.min(96,Math.floor(Math.max(w,h)));size>=6;size--){const result=make(d,size);if(result.fits)return result;}return make(d,6);};
  const preferred:TextDirection=direction==='vertical'||(direction!=='horizontal'&&h/w>=1.8)?'vertical':'horizontal';
  let chosen=fit(preferred);
  if(direction===undefined||direction==='auto'){const alternative=fit(preferred==='vertical'?'horizontal':'vertical');if((!chosen.fits&&alternative.fits)||alternative.size>chosen.size/ .9)chosen=alternative;}
  return make(chosen.direction,Math.max(6,Math.min(chosen.size,Math.round(chosen.size*.9*Math.max(.5,Math.min(2,scale))))));
}
