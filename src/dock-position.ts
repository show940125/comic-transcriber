export function clampDock(x:number,y:number,width:number,height:number,viewportWidth:number,viewportHeight:number){return {x:Math.max(4,Math.min(x,Math.max(4,viewportWidth-width-4))),y:Math.max(4,Math.min(y,Math.max(4,viewportHeight-height-4)))};}
export function draggableDock(holder:HTMLElement,save:(position:{x:number;y:number})=>void){
  let drag:{id:number;x:number;y:number;left:number;top:number;moved:boolean}|undefined,suppressClick=false;
  let anchor:{mode:string;x:number;y:number}|undefined;
  const position=(x:number,y:number)=>{const p=clampDock(x,y,holder.offsetWidth,holder.offsetHeight,innerWidth,innerHeight);holder.style.left=p.x+'px';holder.style.top=p.y+'px';holder.style.right=holder.style.bottom='auto';return p;};
  const down=(event:PointerEvent)=>{const path=event.composedPath(),handle=path.find(el=>el instanceof HTMLElement&&el.hasAttribute('data-comic-drag')) as HTMLElement|undefined;if(event.button!==0||path.some(el=>el instanceof HTMLElement&&el.tagName==='BUTTON'&&!el.hasAttribute('data-comic-drag'))||!handle)return;const r=holder.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:r.left,top:r.top,moved:false};
    // Shadow DOM retargets event.target to the host. Capturing on that host
    // redirects the click away from the orb button and loses its action.
    handle.setPointerCapture(event.pointerId);};
  const move=(event:PointerEvent)=>{if(!drag||drag.id!==event.pointerId)return;if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>6)drag.moved=true;if(drag.moved){event.preventDefault();position(drag.left+event.clientX-drag.x,drag.top+event.clientY-drag.y);}};
  const up=(event:PointerEvent)=>{if(!drag||drag.id!==event.pointerId)return;if(drag.moved){event.preventDefault();suppressClick=true;setTimeout(()=>{suppressClick=false;},0);save(position(holder.offsetLeft,holder.offsetTop));}drag=undefined;};
  const click=(event:MouseEvent)=>{if(suppressClick){suppressClick=false;event.preventDefault();event.stopImmediatePropagation();}};
  const resize=()=>{
    if(anchor){const button=(holder.shadowRoot??holder).querySelector<HTMLElement>('[data-comic-anchor]');if(button?.dataset.comicAnchor===anchor.mode){const rect=button.getBoundingClientRect(),host=holder.getBoundingClientRect();const p=position(host.left+anchor.x-rect.left-rect.width/2,host.top+anchor.y-rect.top-rect.height/2);anchor=undefined;save(p);return;}}
    if(holder.style.left)position(holder.offsetLeft,holder.offsetTop);
  };
  const anchored=(event:Event)=>{const detail=(event as CustomEvent).detail;if(!detail||!['collapsed','expanded'].includes(detail.mode)||!Number.isFinite(detail.x)||!Number.isFinite(detail.y))return;anchor=detail;queueMicrotask(resize);};
  const observer=new ResizeObserver(resize);observer.observe(holder);
  holder.addEventListener('comic-dock-anchor',anchored);holder.addEventListener('click',click,true);holder.addEventListener('pointerdown',down);holder.addEventListener('pointermove',move);holder.addEventListener('pointerup',up);holder.addEventListener('pointercancel',up);addEventListener('resize',resize);
  return ()=>{observer.disconnect();holder.removeEventListener('comic-dock-anchor',anchored);holder.removeEventListener('click',click,true);holder.removeEventListener('pointerdown',down);holder.removeEventListener('pointermove',move);holder.removeEventListener('pointerup',up);holder.removeEventListener('pointercancel',up);removeEventListener('resize',resize);};
}
