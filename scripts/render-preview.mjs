// Local, original drawing fixtures for visual and pixel-level renderer checks.
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),out=path.join(root,'artifacts/render-preview');
await mkdir(out,{recursive:true});
let realRegions=null;try{realRegions=JSON.parse(await readFile(path.join(root,'artifacts/bubble-mask-fix/real-regions.json'),'utf8'));}catch{}
const client=`import {renderPage} from './src/render.ts';
const font=new FontFace('ComicTC','url(/font.otf)');document.fonts.add(await font.load());
const results=[];
for(const style of ['paper','art']){
 const original=document.createElement('canvas');original.width=600;original.height=330;const c=original.getContext('2d');
 c.fillStyle=style==='paper'?'#e7e2d7':'#abb4c1';c.fillRect(0,0,600,330);
 c.strokeStyle='#373737';c.lineWidth=3;c.beginPath();c.moveTo(5,300);c.lineTo(595,300);c.stroke();
 c.fillStyle='#d3b997';c.beginPath();c.ellipse(500,120,65,90,0,0,7);c.fill();c.stroke();
 c.fillStyle='#303338';c.fillRect(465,40,70,18);c.fillRect(450,190,110,90);
 if(style==='paper'){c.fillStyle='#f5f3eb';c.beginPath();c.ellipse(200,165,190,140,0,0,7);c.fill();c.stroke();}
 c.fillStyle='#252525';c.font='26px ComicTC';c.fillText('きみの名前を教えて',65,110);c.fillText('ここで待っているよ',65,230);
 const image=new Image();image.src=original.toDataURL();await image.decode();
 const region={id:style,x:25,y:55,width:350,height:220,translation:'名字？',source:'きみの名前を教えて',render:'auto',kind:'bubble'};
 const before=original.getContext('2d').getImageData(0,0,600,330).data;
 const start=performance.now(),contour=renderPage(image,[region]);const ms=performance.now()-start;
 const rectangle=renderPage(image,[{...region,render:'rectangle'}]);
 const after=contour.getContext('2d').getImageData(0,0,600,330).data,old=rectangle.getContext('2d').getImageData(0,0,600,330).data;
 let outsideChanges=0,changed=0,rectChanged=0,outlineChanges=0;
 for(let p=0;p<600*330;p++){const x=p%600,y=Math.floor(p/600),inside=x>=25&&x<375&&y>=55&&y<275;
 const different=[0,1,2,3].some(k=>before[p*4+k]!==after[p*4+k]);if(different){changed++;if(!inside)outsideChanges++;if(style==='paper'&&before[p*4]<100&&((x-200)/190)**2+((y-165)/140)**2>.92)outlineChanges++;}
 if([0,1,2,3].some(k=>before[p*4+k]!==old[p*4+k]))rectChanged++;
 }
 // Pixels from the first original Japanese line lie well above the new glyph.
 let oldInkRemaining=0,oldInkPixels=0;
 for(let y=78;y<114;y++)for(let x=65;x<330;x++){const p=y*600+x;if(before[p*4]<100&&before[p*4+1]<100){oldInkPixels++;if(after[p*4]<100)oldInkRemaining++;}}
 results.push({style,ms,outsideChanges,outlineChanges,changed,rectangleChanged:rectChanged,oldInkPixels,oldInkRemaining,reduction:1-changed/rectChanged});
 const row=document.createElement('section');const heading=document.createElement('h2');heading.textContent=style==='paper'?'淺底氣泡':'插畫底圖';row.append(heading);
 for(const [label,canvas]of [['原圖',original],['矩形浮層',rectangle],['字形白底＋局部遮蓋',contour]]){const panel=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=label;panel.append(caption,canvas);row.append(panel);}document.querySelector('main').append(row);
}
document.querySelector('#metrics').textContent=JSON.stringify(results,null,2);
const passed=results.every(r=>r.outsideChanges===0&&r.outlineChanges===0&&r.oldInkPixels>0&&r.oldInkRemaining===0&&r.reduction>.3);
document.querySelector('#status').textContent=passed?'passed':'failed';
const realRegions=${JSON.stringify(realRegions)};
if(realRegions){
 const img=new Image();img.src='/real.jpg';await img.decode();
 const row=document.createElement('section'),heading=document.createElement('h2');heading.textContent='本機實際案例：閉合氣泡與格邊開口';row.append(heading);
 for(const [label,regions]of [['原圖',null],['矩形模式',realRegions.map(r=>({...r,render:'rectangle'}))],['氣泡內部限制',realRegions]]){
  const page=regions?renderPage(img,regions):renderPage(img,[],true),crop=document.createElement('canvas');crop.width=800;crop.height=240;crop.getContext('2d').drawImage(page,0,0,800,240,0,0,800,240);
  const panel=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=label;panel.append(caption,crop);row.append(panel);
 }document.querySelector('main').append(row);
}
document.querySelector('#finish').onclick=()=>fetch('/finish',{method:'POST'}).then(()=>document.querySelector('#finish').disabled=true);
`;
await build({stdin:{contents:client,resolveDir:root,sourcefile:'render-preview-client.ts',loader:'ts'},bundle:true,format:'esm',outfile:path.join(out,'client.js')});
const html='<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>墨譯字形白底比較</title><style>body{margin:20px;background:#eee;font-family:system-ui}h1{font-size:24px}section{display:flex;flex-wrap:wrap;gap:12px}h2{width:100%;font-size:18px;margin:12px 0 0}figure{margin:0;flex:1;min-width:270px}canvas{width:100%;max-width:600px;background:white}figcaption{margin:8px 0}pre{font-size:12px}button{padding:8px}</style><h1>墨譯：矩形底與字形白底</h1><p>原創示意圖；黑字、不透明白底，原文筆畫另外局部遮蓋。</p><p id="status">loading</p><main></main><details><summary>像素檢查與耗時</summary><pre id="metrics"></pre></details><button id="finish">結束測試伺服器</button><script type="module" src="/client.js"></script></html>';
if(process.argv.includes('--build-only')){console.log('Preview client rebuilt; existing server unchanged');process.exit(0);}
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/finish'&&req.method==='POST'){res.end('closed');server.close();return;}
  if(req.url==='/font.otf'){res.setHeader('Content-Type','font/otf');res.end(await readFile(path.join(root,'public/fonts/NotoSansCJKtc-Regular.otf')));return;}
  if(req.url==='/real.jpg'&&realRegions){res.setHeader('Content-Type','image/jpeg');res.end(await readFile(path.join(root,'artifacts/bubble-mask-fix/real-original.jpg')));return;}
  if(req.url==='/client.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(out,'client.js')));return;}
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  res.writeHead(404).end();
 }catch(error){res.writeHead(500).end(String(error));}
});
server.listen(0,'127.0.0.1',async()=>{const url='http://127.0.0.1:'+server.address().port+'/';await writeFile(path.join(out,'server.json'),JSON.stringify({url,pid:process.pid,started:new Date().toISOString()}));console.log(url);});
