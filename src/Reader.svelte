<script lang="ts">
  import { onMount } from 'svelte';
  import { defaults, type Region, type Settings, type Diagnostic, type PageData } from './types';
  import { hashBlob, readingOrder, clampRegion, contentSignature, importCorrection } from './core';
  import { loadPage, legacyPages, replaceCachedPage, undoCachedPage, settings as readSettings, type PageEditReceipt } from './storage';
  import {engine} from './runtime';
  import {ocrBytes} from './ocr-models';
  import {withCandidate,applyCandidate,splitRegion} from './ocr-review';
  import { renderPage, loadFont } from './render';
  import { prepareChromeTranslator,disposeChromeTranslator } from './chrome-translator';
  import { needsOcrReview, ocrReviewWarning } from './ocr-quality';
  import { imageBytes } from './binary';
  import { publicImageUrl } from './core';
  import {detectSession,ocrSession,translateSession,processSession,saveSession,encodeSession,sessionData,type PageSession} from './page-pipeline';
  import {extensionCall,detached} from './extension-context';
  import {correctionRegions,type CorrectionBinding} from './correction-import';
  import {SerialLane} from './scheduling';
  let { siteInput, chapterNav, onClose, siteTargetCurrent, onSiteApply, onSiteError, onSiteSummary, onSiteProgress, onSiteBusy, onSiteReview }: {
    siteInput?: {base64?:string; mime?:string; imageUrl?:string; auto?:boolean; priorSummary?:string;sourcePageUrl?:string;pageIndex?:number;pageData?:PageData};
    siteTargetCurrent?:()=>boolean;
    chapterNav?:{index:number;pages:{src:string;ready:boolean;failed:boolean}[];select:(index:number)=>void};
    onClose?:()=>void;
    onSiteApply?: (bytes:Uint8Array<ArrayBuffer>,page?:PageData)=>void;
    onSiteError?: (error:string)=>void;
    onSiteSummary?: (summary:string)=>void;
    onSiteProgress?: (diagnostic:Diagnostic)=>void;
    onSiteBusy?: (busy:boolean)=>void;
    onSiteReview?: (count:number)=>void;
  } = $props();
  let config = $state<Settings>({ ...defaults }), blob: Blob | undefined;
  let image = $state<HTMLImageElement | undefined>();
  let regions = $state<Region[]>([]), selected = $state(''), hash = '', busy = $state(false), original = $state(false);
  let message = $state(''), error = $state(''), diagnostics = $state<Diagnostic[]>([]);
  let preview: HTMLDivElement, canvas = $state<HTMLCanvasElement | undefined>();
  let drawing = $state(false), filename = $state('comic'), aborter: AbortController | undefined;
  let backend = $state('待測'), drawingStart: { x: number; y: number } | undefined;
  let alive=true;
  let fontReady = $state(false), imageUrl = '', signature = '';
  let remoteImageUrl = $state(''), permissionOrigin = $state('');
  let metadata:PageSession['metadata'];let legacyModelKey:string|undefined;
  let legacy=$state<PageData[]>([]),cropUrl=$state(''),splitting=$state(false);
  type Rerun = 'detect'|'ocr';
  type SplitPreview = {hash:string;id:string;content:string;axis:'x'|'y';position:number;children:Region[]};
  let splitPreview=$state<SplitPreview>(), splitAxis=$state<'x'|'y'>('x'), splitPercent=$state(50);
  let undo=$state.raw<{page:PageSession;selected:string;label:string;receipt:PageEditReceipt}>();
  let rerun=$state<Rerun>(), rerunDialog: HTMLDialogElement;
  let panel=$state<'text'|'layout'>('text');
  let imageInput=$state<HTMLInputElement>(),correctionInput=$state<HTMLInputElement>();
  let dirty=$state(false), saving=$state(0), saveFailed=$state(false);
  let committing=$state(false),editVersion:string|undefined;
  const writes=new SerialLane();
  const privateFiles=$derived(!siteInput&&parent===window&&location.protocol==='chrome-extension:'&&location.host===chrome.runtime.id);
  const editorId=crypto.randomUUID();let importActive=true,importBinding:CorrectionBinding|undefined;
  const deliveredImports=new Set<string>();
  function invalidatePendingImport(){importBinding=undefined;if(siteInput)detached(()=>chrome.runtime.sendMessage({channel:'correction-import-invalidate',editorId}));}
  export function retireImport(){importActive=false;invalidatePendingImport();}
  export function showError(value:unknown){error=value instanceof Error?value.message:String(value);}
  function currentImport(binding:CorrectionBinding){return alive&&importActive&&!busy&&!!siteInput&&siteTargetCurrent?.()===true&&importBinding?.hash===binding.hash&&binding.editorId===editorId&&hash===binding.hash&&image?.naturalWidth===binding.width&&image.naturalHeight===binding.height;}
  function openPrivateReader(event:MouseEvent){if(event.isTrusted)detached(()=>chrome.runtime.sendMessage({channel:'open-private-reader'}),e=>{error=String(e);});}
  async function openCorrectionImport(event:MouseEvent){
    if(!event.isTrusted||!image||busy||!importActive||!siteTargetCurrent?.())return;
    importBinding={editorId,hash,width:image.naturalWidth,height:image.naturalHeight};
    try{const result=await extensionCall(()=>chrome.runtime.sendMessage({channel:'correction-import-open',binding:importBinding}));if(!result?.ok)throw Error(result?.error??'校正匯入未回應');}catch(e){error=String(e);}
  }
  async function loadRemote() {
    if (!remoteImageUrl) return;
    const response = await extensionCall(()=>chrome.runtime.sendMessage({ channel:'fetch-image', url:remoteImageUrl }));
    if (!response?.ok) {
      permissionOrigin = response?.permissionOrigin ?? '';
      throw new Error(response?.error ?? '圖片讀取失敗，請重試');
    }
    permissionOrigin = '';
    const bytes = typeof response.base64 === 'string' ? imageBytes(response.base64) : new Uint8Array(response.bytes);
    await load(new Blob([bytes], {type:response.mime}), 'web-comic');
  }
  async function grantImage() {
    // Invoke synchronously in the actual button click before any awaited work.
    const grant = siteInput ? extensionCall(()=>chrome.runtime.sendMessage({channel:'grant-image',origin:permissionOrigin})).then(r=>{if(r.error)throw new Error(r.error);return r.ok;}) : chrome.permissions.request({ origins:[permissionOrigin] });
    await action(async () => {
      if (!await grant) throw new Error('圖片來源授權未核准；可重新授權或選擇本機圖片');
      await loadRemote();
    });
  }
  const active = $derived(regions.find(r => r.id === selected));
  const candidate = $derived(active?.ocrCandidates?.at(-1));
  const difference = $derived.by(()=>{
    const before=Array.from(active?.source??''),after=Array.from(candidate?.source??'');
    let start=0,end=0;
    while(start<before.length&&before[start]===after[start])start++;
    while(end<before.length-start&&end<after.length-start&&before[before.length-1-end]===after[after.length-1-end])end++;
    return {prefix:after.slice(0,start).join(''),added:after.slice(start,after.length-end).join(''),removed:before.slice(start,before.length-end).join(''),suffix:end?after.slice(-end).join(''):''};
  });
  const currentOcrProfile = $derived(active?.ocr?.profile==='fp32'?'fp32':active?.ocr?.profile==='int8'?'int8':config.ocrProfile);
  const otherProfile = $derived(currentOcrProfile==='int8'?'fp32':'int8');
  function clearSplit(){splitPreview=undefined;splitting=false;drawingStart=undefined;}
  function selectRegion(id:string){if(id!==selected)clearSplit();selected=id;}
  function edited(){undo=undefined;editVersion=undefined;clearSplit();dirty=true;}
  $effect(()=>{const r=active,img=image;if(!r||!img){cropUrl='';return;}const rect=r.ocrBox??r,c=document.createElement('canvas');c.width=Math.max(1,rect.width);c.height=Math.max(1,rect.height);c.getContext('2d')!.drawImage(img,rect.x,rect.y,rect.width,rect.height,0,0,c.width,c.height);cropUrl=c.toDataURL();});
  function invalidateRefinement(){if(metadata)delete metadata.refinement;}
  async function compare(profile:'int8'|'fp32'){
    if(!blob||!active)return;const id=active.id,oldHash=hash;
    const result=await engine({op:'ocr',image:blob,regions:[$state.snapshot(active)],provider:config.ocrProvider,profile},progress,aborter?.signal);
    aborter?.signal.throwIfAborted();if(!alive||hash!==oldHash)return;
    const candidate=result[0]?.ocr;if(!candidate)throw Error('OCR 未回傳候選來源');
    await storeRegions(regions.map(r=>r.id===id?withCandidate(r,candidate):r),{preserveRefinement:true});
    message='已儲存 OCR 候選，可核對後採用';
  }
  async function chooseCandidate(index:number){
    const r=active,c=r?.ocrCandidates?.[index];if(!r||!c)return;
    const changed=c.source!==r.source;
    await storeRegions(regions.map(item=>item.id===r.id?applyCandidate(item,c):item),{preserveRefinement:!changed,updatePreview:true,label:'採用新原文'});
    message=changed?'已採用新原文，此框需要重新翻譯':'已更新此框的 OCR 來源，譯文已保留';
  }
  function previewSplit(axis:'x'|'y',position:number){
    if(!active)return;
    splitPreview=undefined;error='';
    try{
      const region=$state.snapshot(active);
      splitPreview={hash,id:region.id,content:JSON.stringify(region),axis,position,children:splitRegion(region,axis,position)};
    }catch(e){error=e instanceof Error?e.message:String(e);}
  }
  function previewSplitAtPercent(){
    if(!active)return;
    const length=splitAxis==='x'?active.width:active.height;
    previewSplit(splitAxis,active[splitAxis]+length*splitPercent/100);
  }
  async function applySplit(){
    const preview=splitPreview,r=active;
    if(!preview||!r||preview.hash!==hash||preview.id!==r.id||preview.content!==JSON.stringify($state.snapshot(r))){
      clearSplit();throw new Error('文字框已變更，請重新預覽拆框');
    }
    const next=[...regions].sort((a,b)=>a.order-b.order)
      .flatMap(region=>region.id===preview.id?$state.snapshot(preview.children):[region])
      .map((region,order)=>({...region,order}));
    await storeRegions(next,{label:'拆框',selected:preview.children[0].id,updatePreview:true});
    message='已拆框，新框可分別辨識';
  }
  async function undoEdit(){
    const previous=undo;if(!previous||previous.page.hash!==hash)return;
    committing=true;
    try{await writes.run(()=>undoCachedPage(previous.receipt));}finally{committing=false;}
    setSession(previous.page,previous.selected);
    undo=undefined;clearSplit();dirty=true;message=`已撤銷${previous.label}`;
  }
  async function restoreLegacy(page:PageData){const checked=importCorrection(page,hash,image!.naturalWidth,image!.naturalHeight);edited();legacyModelKey=page.modelKey;signature=page.modelKey;regions=checked;metadata={...metadata,refinement:undefined};selected=regions[0]?.id??'';message='已載入舊結果；OCR 模型來源未標記';paint();}
  function progress(d: Diagnostic) { message = d.message;if(d.backend)backend=d.backend;diagnostics = [...diagnostics.slice(-99), d]; onSiteProgress?.(d); }
  function paint() {
    if (!image || !preview) return;
    const warnings=new Map<string,string[]>();
    const old=canvas;
    canvas = renderPage(image, regions, original,(id,message)=>warnings.set(id,[...(warnings.get(id)??[]),message]));
    if(!original)regions=regions.map(r=>({...r,warnings:[...r.warnings.filter(w=>!/^原文清除需校正|^中文空間不足/.test(w)),...(warnings.get(r.id)??[])]}));
    canvas.setAttribute('aria-label', '漫畫預覽');
    preview.replaceChildren(canvas);
    if(old)old.width=old.height=0;
  }
  async function action(work: () => Promise<void>, cancelledMessage='已取消目前操作，完成部分已保留') {
    if (busy) return; busy = true; onSiteBusy?.(true); error = ''; aborter = new AbortController();
    try { await work(); }
    catch (e) { const cancelled=aborter.signal.aborted;error=cancelled?'':e instanceof Error?e.message:String(e);if(cancelled)progress({stage:'cancelled',message:cancelledMessage,cause:'cancel'});else{onSiteError?.(error);if(parent!==window)parent.postMessage({channel:'comic-error',token:location.hash.slice(1),error},'*');} }
    finally { busy = false; if(alive){onSiteBusy?.(false);try{paint();}catch(e){error=String(e);}} }
  }
  function session():PageSession {
    if(!blob||!image)throw new Error('請先載入圖片');
    return {blob,image,regions:$state.snapshot(regions),hash,modelKey:signature,legacyModelKey,editVersion,config:$state.snapshot(config),cacheScope:privateFiles?'private':undefined,metadata:structuredClone(metadata)};
  }
  const hooks=()=>({progress,signal:aborter?.signal});
  function setSession(page:PageSession,id=selected){
    regions=page.regions;signature=page.modelKey;legacyModelKey=page.legacyModelKey;metadata=page.metadata;editVersion=page.editVersion;
    selectRegion(regions.some(r=>r.id===id)?id:regions[0]?.id??'');
  }
  async function runStage(work:(page:PageSession,options:ReturnType<typeof hooks>&{partial:()=>void})=>Promise<void>){
    clearSplit();undo=undefined;editVersion=undefined;
    const page=session();
    const partial=()=>{if(alive){setSession(page);dirty=true;saveFailed=false;paint();}};
    await writes.run(()=>work(page,{...hooks(),partial}));
  }
  async function persist(page:PageSession){
    saving++;
    try{await writes.run(()=>saveSession(page));saveFailed=false;}
    catch(e){saveFailed=true;throw e;}
    finally{saving--;}
  }
  async function save(){if(image&&hash)await persist(session());}
  async function commit(page:PageSession,previous:PageSession,label?:string){
    committing=true;
    try{
      if(label){
        page.editVersion=crypto.randomUUID();
        const receipt=await writes.run(()=>replaceCachedPage(sessionData(page)));
        undo={page:previous,selected,label,receipt};saveFailed=false;
      }else{
        page.editVersion=undefined;await persist(page);undo=undefined;
      }
    }finally{committing=false;}
  }
  async function storeRegions(next:Region[],options:{label?:string;selected?:string;preserveRefinement?:boolean;updatePreview?:boolean}={}){
    const previous=session(),page={...previous,regions:structuredClone($state.snapshot(next)),metadata:structuredClone(previous.metadata)};
    if(!options.preserveRefinement&&page.metadata)delete page.metadata.refinement;
    await commit(page,previous,options.label);
    setSession(page,options.selected);
    clearSplit();if(options.updatePreview)dirty=true;
  }
  async function load(input: Blob, name = 'comic') {
    if (input.size > 20 * 1024 * 1024 || !input.type.startsWith('image/')) throw new Error('請使用 20 MB 以內的圖片');
    const url=URL.createObjectURL(input),next=new Image();
    try{
      next.src=url;await next.decode();aborter?.signal.throwIfAborted();
      if(next.naturalWidth*next.naturalHeight>30_000_000)throw new Error('圖片超過 3000 萬像素，請先裁切');
      const nextHash=await hashBlob(input);
      if(!alive)return;
      await writes.run(async()=>{});
      if(imageUrl)URL.revokeObjectURL(imageUrl);
      imageUrl=url;image=next;blob=input;filename=name;hash=nextHash;
    }finally{if(imageUrl!==url)URL.revokeObjectURL(url);}
    clearSplit();undo=undefined;editVersion=undefined;dirty=false;saveFailed=false;legacyModelKey=undefined;invalidatePendingImport();
    signature=contentSignature(config,privateFiles?'private':undefined);
    const supplied=siteInput?.pageData;
    let cached=await loadPage(hash,signature);legacy=await legacyPages(hash,privateFiles);
    if(supplied?.hash===hash&&supplied.width===image.naturalWidth&&supplied.height===image.naturalHeight){cached=await loadPage(hash,supplied.modelKey)??supplied;}
    if(cached){let direct=false;try{const key=JSON.parse(cached.modelKey);direct=(key[0]==='private-reader-v1'?JSON.parse(key[1]):key)[1]==='gemini-web';}catch{}if(direct){config.backend='gemini-web';config.priorSummary=(await readSettings()).priorSummary;signature=contentSignature(config,privateFiles?'private':undefined);}}
    regions = (cached?.regions??[]).map(r=>({...r,bubbleBox:r.bubbleBox??(r.kind==='bubble'?r.ocrBox:undefined),ocrDone:r.ocrDone??(!!r.source.trim()||r.warnings.some(w=>/疑似無文字|缺少日文字元/.test(w)))}));
    selected=regions.find(r=>r.needsReview)?.id??regions[0]?.id??'';original=false;panel='text';
    metadata={sourcePageUrl:siteInput?.sourcePageUrl??cached?.sourcePageUrl,imageUrl:siteInput?.imageUrl??cached?.imageUrl,pageIndex:siteInput?.pageIndex??cached?.pageIndex,refinement:cached?.refinement};
    if(cached&&cached.modelKey!==signature)legacyModelKey=cached.modelKey;
    if(siteInput&&cached)dirty=!supplied||JSON.stringify(cached.regions)!==JSON.stringify(supplied.regions);
    message=cached?'已載入這張圖的上次校正':'圖片已載入，可以開始翻譯或框選';paint();
  }
  function requestRerun(kind:Rerun){
    if(!regions.length){void action(()=>rerunPage(kind),'已取消，原結果已保留');return;}
    rerun=kind;rerunDialog.showModal();
  }
  function closeRerun(){rerunDialog.close();rerun=undefined;}
  async function rerunPage(kind:Rerun){
    const previous=session(),page=session(),label=kind==='detect'?'整頁重偵測':'整頁重辨識';
    clearSplit();drawing=false;
    const options={...hooks(),persist:false};
    await (kind==='detect'?detectSession(page,options):ocrSession(page,options));
    options.signal?.throwIfAborted();
    if(!alive||previous.hash!==hash||siteInput&&siteTargetCurrent?.()!==true)throw new Error('原圖片已變更，原結果已保留');
    if(page.metadata)delete page.metadata.refinement;
    await commit(page,previous,previous.regions.length?label:undefined);
    setSession(page);dirty=true;
    message=kind==='detect'?`已重新偵測 ${regions.length} 個文字框`:`已重新辨識 ${regions.length} 個文字框`;
  }
  async function translate(){
    if(!siteInput?.auto)await extensionCall(()=>chrome.runtime.sendMessage({channel:'translation-resume'}));
    if(config.backend==='chrome'&&!siteInput){await prepareChromeTranslator(progress,aborter?.signal);disposeChromeTranslator();}
    await runStage(translateSession);
  }
  async function translatePage(){
    if(!image)return;original=false;if(!siteInput?.auto)await extensionCall(()=>chrome.runtime.sendMessage({channel:'translation-resume'}));
    if(config.backend==='chrome'&&!siteInput){await prepareChromeTranslator(progress,aborter?.signal);disposeChromeTranslator();}
    await runStage(processSession);
    progress({stage:regions.some(r=>r.needsReview)?'review':'complete',message:regions.some(r=>r.needsReview)?'部分原文需核對，其餘譯文已保留':'本張處理完成，可校正或匯出'});
  }
  async function applyToPage(){
    if(!image)return;
    if(siteInput&&siteTargetCurrent?.()!==true)throw new Error('漫畫已換圖，請重新開啟工作台');
    const page=session(),data=await writes.run(()=>encodeSession(page,!!siteInput),aborter?.signal);
    aborter?.signal.throwIfAborted();if(!alive)return;
    const summary=regions.map(r=>r.translation).filter(Boolean).join('\n').slice(-1200);
    if(onSiteApply){setSession(page);onSiteSummary?.(summary);onSiteReview?.(regions.filter(r=>r.needsReview||r.warnings.some(w=>/^原文清除需校正|^中文空間不足/.test(w))).length);onSiteApply(data,sessionData(page));dirty=false;saveFailed=false;message='已套用至漫畫頁';return;}
    parent.postMessage({channel:'comic-result',token:location.hash.slice(1),summary,bytes:[...data]},'*');
  }
  function point(event: PointerEvent) {
    const rect = preview.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (image?.naturalWidth ?? 1) / rect.width, y: (event.clientY - rect.top) * (image?.naturalHeight ?? 1) / rect.height };
  }
  function down(event: PointerEvent) { if (event.button===0&&(drawing||splitting) && image && !busy) { drawingStart = point(event); preview.setPointerCapture(event.pointerId); } }
  function up(event: PointerEvent) {
    if (!drawingStart || !image) return;
    const end = point(event), start = drawingStart; drawingStart = undefined;
    if(splitting&&active){
      if(Math.hypot(end.x-start.x,end.y-start.y)<4)return;
      const axis=Math.abs(end.x-start.x)>=Math.abs(end.y-start.y)?'y':'x',position=(start[axis]+end[axis])/2;
      splitAxis=axis;splitPercent=Math.round((position-active[axis])*100/(axis==='x'?active.width:active.height));
      previewSplit(axis,position);return;
    }
    if (Math.abs(end.x - start.x) < 4 || Math.abs(end.y - start.y) < 4) return;
    edited();invalidateRefinement();
    const r = clampRegion({ id: crypto.randomUUID(), x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y), source: '', translation: '', order: regions.length, score: 1, warnings: ['人工框選'], kind: 'bubble', render: 'auto' }, image.naturalWidth, image.naturalHeight);
    regions = readingOrder([...regions, r]); selected = r.id; drawing = false; paint(); detached(save,e=>{error=String(e);});
  }
  function update(field: keyof Region, value: unknown) {
    if(!image||!active||active[field]===value)return;
    edited();if(['source','translation','x','y','width','height','order'].includes(field))invalidateRefinement();
    regions = regions.map(r => r.id === selected ? clampRegion({ ...r, ...(['x','y','width','height'].includes(field) ? { ocrBox: undefined,bubbleBox:undefined,ocr:undefined,ocrCandidates:undefined,ocrDone:false } : {}), ...(field==='source'?{ocr:undefined,ocrCandidates:undefined,initialTranslation:undefined,ocrDone:!!String(value).trim(),translation:value!==r.source?'':r.translation,needsReview:needsOcrReview(String(value)),warnings:[...r.warnings.filter(w=>w!==ocrReviewWarning),...(needsOcrReview(String(value))?[ocrReviewWarning]:[])]}:{}), [field]: value }, image!.naturalWidth, image!.naturalHeight) : r); paint(); detached(save,e=>{error=String(e);});
  }
  async function remove(){await storeRegions(regions.filter(r=>r.id!==selected).map((r,order)=>({...r,order})),{label:'刪除文字框',updatePreview:true});message='已刪除選取的文字框';}
  async function merge() {
    const a = active, b = regions.find(r => r.order === (a?.order ?? -2) + 1); if (!a || !b) return;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const r = { ...a, ocr:undefined,ocrCandidates:undefined,initialTranslation:undefined,ocrBox: undefined,bubbleBox:undefined, x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y, source: a.source + b.source, translation: [a.translation, b.translation].filter(Boolean).join('\n') };
    await storeRegions(regions.filter(v=>v.id!==b.id).map((v,order)=>({...v.id===a.id?r:v,order})),{label:'合併文字框',updatePreview:true});message='已合併文字框';
  }
  function exportJson() { if (!image) return; download(new Blob([JSON.stringify({ schema: 1, hash, width: image.naturalWidth, height: image.naturalHeight, regions: $state.snapshot(regions), diagnostics }, null, 2)], { type: 'application/json' }), `${filename}.json`); }
  function download(data: Blob, name: string) { const url = URL.createObjectURL(data), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  onMount(() => {
    alive=true;
    const token = location.hash.slice(1);
    let allowedOrigin = '';
    const receive = (event: MessageEvent) => {
      if (event.source !== parent || !allowedOrigin || event.origin !== allowedOrigin || !token || event.data?.token !== token || event.data?.channel !== 'comic-image') return;
      if (typeof event.data.imageUrl === 'string') {
        try { remoteImageUrl = publicImageUrl(event.data.imageUrl).href; } catch { return; }
        void action(loadRemote); return;
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        if (typeof event.data.base64 === 'string') bytes = imageBytes(event.data.base64);
        else if (Array.isArray(event.data.bytes) && event.data.bytes.length <= 20 * 1024 * 1024) bytes = new Uint8Array(event.data.bytes);
        else return;
      } catch { return; }
      void action(async () => { if (event.data.auto && typeof event.data.priorSummary === 'string') config.priorSummary = event.data.priorSummary; await load(new Blob([bytes], { type: event.data.mime }), 'web-comic'); if (event.data.auto) { await translatePage(); await applyToPage(); } });
    };
    addEventListener('message', receive);
    const receiveImport=(request:any,sender:chrome.runtime.MessageSender,reply:(value:any)=>void)=>{
      if(request?.channel!=='correction-import-deliver'||request.binding?.editorId!==editorId)return;
      const binding=request.binding as CorrectionBinding;
      if(sender.id!==chrome.runtime.id||sender.tab||request.sourceUrl!==location.href||!currentImport(binding)||deliveredImports.has(request.id)){reply({ok:false,error:'原工作台或圖片已變更，拒絕套用校正'});return;}
      let checked:Region[];try{checked=correctionRegions(request.regions,binding);}catch(e){reply({ok:false,error:String(e)});return;}
      deliveredImports.add(request.id);busy=true;onSiteBusy?.(true);
      void (async()=>{
        if(!alive||!importActive||!siteTargetCurrent?.()||hash!==binding.hash)throw Error('原工作台已失效');
        await storeRegions(checked,{label:'匯入校正',selected:checked[0]?.id??'',updatePreview:true});
        if(!alive||!importActive||!siteTargetCurrent?.()||hash!==binding.hash)throw Error('原工作台已失效；已存校正不重送');
        paint();message='校正已匯入，可套用至漫畫頁';importBinding=undefined;return {ok:true};
      })().then(reply,e=>{error=String(e);reply({ok:false,error});}).finally(()=>{busy=false;if(alive)onSiteBusy?.(false);});return true;
    };
    if(siteInput)chrome.runtime.onMessage.addListener(receiveImport);
    const stop = () => {retireImport();aborter?.abort();disposeChromeTranslator();}; addEventListener('pagehide', stop);
    detached(async () => { config = await readSettings(); if (token && parent !== window) { const authority = await extensionCall(()=>chrome.runtime.sendMessage({ channel: 'frame-authority', token })); if (authority?.ok) allowedOrigin = authority.origin; else { error = '未授權的嵌入工作台，請從墨譯按鈕開啟'; return; } } try { await loadFont(!!siteInput); fontReady = true; } catch { error = '繁中字型載入失敗，暫用系統字型'; } if (allowedOrigin) parent.postMessage({ channel: 'comic-ready', token }, allowedOrigin);
      if(alive&&siteInput)void action(async()=>{if(siteInput.priorSummary)config.priorSummary=siteInput.priorSummary;if(siteInput.imageUrl){remoteImageUrl=publicImageUrl(siteInput.imageUrl).href;await loadRemote();}else if(siteInput.base64)await load(new Blob([imageBytes(siteInput.base64)],{type:siteInput.mime}),'web-comic');if(siteInput.auto){await translatePage();await applyToPage();}});
    },e=>{error=String(e);});
    return () => { alive=false;stop();if(siteInput)detached(()=>chrome.runtime.onMessage.removeListener(receiveImport));removeEventListener('pagehide', stop); removeEventListener('message', receive); if (imageUrl) URL.revokeObjectURL(imageUrl); };
  });
</script>

<svelte:head>{#if !siteInput}<title>墨譯 · 漫畫工作台</title>{/if}</svelte:head>

<main class="moyu" class:site={!!chapterNav} class:empty-reader={!image&&!siteInput}>
  <div class="top">
    <header>
      <div class="heading">
        <h1 id="comic-editor-title" tabindex="-1">{chapterNav?'章節工作台':'墨譯漫畫工作台'}</h1>
        {#if chapterNav}<span class="page-count">第 {chapterNav.index+1}／{chapterNav.pages.length} 張</span>{/if}
      </div>
      {#if chapterNav}
        <button onclick={onClose}>關閉工作台</button>
      {:else if !siteInput}
        <a href="options.html" target="_blank" rel="noopener">模型與閱讀設定</a>
      {/if}
    </header>
    {#if chapterNav||image}
    <div class="navigation-actions">
      {#if chapterNav}<nav class="pager" aria-label="切換章節頁面">
        <button disabled={busy||chapterNav.index===0} onclick={()=>chapterNav?.select(chapterNav.index-1)}>上一張</button>
        <select aria-label="切換章節圖片" value={chapterNav.index} disabled={busy} onchange={e=>chapterNav?.select(Number(e.currentTarget.value))}>
          {#each chapterNav.pages as page,index}<option value={index}>第 {index+1} 張{page.ready?' · 已有譯圖':page.failed?' · 待處理':''}</option>{/each}
        </select>
        <button disabled={busy||chapterNav.index===chapterNav.pages.length-1} onclick={()=>chapterNav?.select(chapterNav.index+1)}>下一張</button>
      </nav>{/if}
    {#if image}
      <div class="toolbar" aria-label="頁面操作">
        {#if privateFiles}<button disabled={busy} onclick={()=>imageInput?.click()}>選擇其他圖片</button>{/if}
        {#if !siteInput}
          <button class="primary" disabled={busy} onclick={()=>action(translatePage)}>一鍵翻譯</button>
        {:else if !regions.length}
          <button class="primary" disabled={busy} onclick={()=>action(translatePage)}>翻譯這張圖</button>
        {/if}
        {#if regions.some(r=>r.source.trim()&&!r.needsReview&&!r.translation.trim())}
          <button disabled={busy} onclick={()=>action(translate)}>翻譯待處理文字</button>
        {/if}
        <details class="menu">
          <summary>頁面工具</summary>
          <div class="menu-items">
            <button disabled={busy} onclick={()=>requestRerun('detect')}>{regions.length?'整頁重偵測':'偵測文字框'}</button>
            <button disabled={busy||!regions.length} onclick={()=>requestRerun('ocr')}>{regions.some(r=>r.ocrDone||r.source)?'整頁重辨識':'辨識日文'}</button>
            {#if regions.length}<button disabled={busy} onclick={()=>action(translate)}>翻譯繁中</button>{/if}
            <button aria-pressed={drawing} disabled={busy} onclick={()=>{clearSplit();drawing=!drawing;}}>手動框選</button>
            {#if privateFiles}<button disabled={busy} onclick={()=>correctionInput?.click()}>載入校正 JSON</button>
            {:else if siteInput}<button disabled={busy} onclick={openCorrectionImport}>載入校正（獨立分頁）</button>{/if}
            {#if siteInput}<button onclick={()=>detached(()=>chrome.runtime.sendMessage({channel:'open-options'}),e=>{error=String(e);})}>模型與閱讀設定</button>{/if}
          </div>
        </details>
        {#if drawing}<span class="mx-note">在漫畫預覽上拖曳以新增文字框</span>{/if}
      </div>
    {/if}
    </div>
    {/if}
    {#if privateFiles}
      <input class="visually-hidden" bind:this={imageInput} type="file" accept="image/*" aria-label="選擇漫畫圖片" tabindex="-1" disabled={busy}
        onchange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(file)void action(()=>load(file,file.name.replace(/\.[^.]+$/, '')));}} />
      <input class="visually-hidden" bind:this={correctionInput} type="file" accept="application/json,.json" aria-label="載入校正 JSON" tabindex="-1" disabled={!image||busy}
        onchange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(file&&image)void action(async()=>{if(file.size>2*1024*1024)throw new Error('校正檔超過 2 MB');const checked=importCorrection(JSON.parse(await file.text()),hash,image!.naturalWidth,image!.naturalHeight);await storeRegions(checked,{label:'匯入校正',selected:checked[0]?.id??'',updatePreview:true});message='已匯入所選校正檔';});}} />
    {/if}
    {#if error}<p class="mx-alert" role="alert">{error}</p>{/if}
    {#if permissionOrigin}
      <div class="access"><p>授權 {permissionOrigin.replace('/*','')} 後，就能讀取這張漫畫圖片。</p><button disabled={busy} onclick={grantImage}>授權圖片來源並重試</button></div>
    {:else if remoteImageUrl && !image && !busy}
      <button onclick={()=>action(loadRemote)}>重新讀取網站圖片</button>
    {/if}
  </div>

  <div class="workspace" class:has-chapter={!!chapterNav}>
    {#if chapterNav}
      <nav class="rail" aria-label="章節全部圖片">
        {#each chapterNav.pages as page,index}
          <button aria-label={`開啟第 ${index+1} 張漫畫${page.ready?'，已有譯圖':''}`} aria-current={index===chapterNav.index?'page':undefined}
            disabled={busy} onclick={()=>chapterNav?.select(index)}>
            <img src={page.src} alt="" loading="lazy" draggable="false" />
            <span>{index+1}{#if page.failed}<b title="待處理"> · 待處理</b>{/if}</span>
          </button>
        {/each}
      </nav>
    {/if}
    <section class="stage" aria-label="漫畫預覽區">
      {#if image}
        <div class="view-controls mx-segments" role="group" aria-label="比較原圖與譯圖">
          <button aria-pressed={original} disabled={busy} onclick={()=>{original=true;paint();}}>原圖</button>
          <button aria-pressed={!original} disabled={busy} onclick={()=>{original=false;paint();}}>譯圖</button>
        </div>
      {:else}
        <div class="empty">
          {#if siteInput}
            <p>{busy?'正在讀取圖片…':'準備這張漫畫圖片'}</p>
          {:else}
            <h2>選一張漫畫圖片</h2>
            <p>辨識日文、翻成繁體中文，也可以逐框校正文字和排版。</p>
            <button class="primary" disabled={busy} onclick={privateFiles?()=>imageInput?.click():openPrivateReader}>選擇圖片</button>
            <small class="mx-note">支援 PNG、JPEG 等瀏覽器可讀格式，單張最多 20 MB。</small>
          {/if}
        </div>
      {/if}
      <div class="paper">
        <div class="image-wrap" class:drawing={drawing||splitting} bind:this={preview} role="presentation" onpointerdown={down} onpointerup={up} onpointercancel={()=>{drawingStart=undefined;}}></div>
        {#if image}
          {#if splitPreview}
            {#each splitPreview.children as child,index}
              <div class="split-guide" style={`left:${child.x/image.naturalWidth*100}%;top:${child.y/image.naturalHeight*100}%;width:${child.width/image.naturalWidth*100}%;height:${child.height/image.naturalHeight*100}%`} aria-hidden="true"><span>{index+1}</span></div>
            {/each}
          {/if}
          <div class="regions">
            {#each regions as r (r.id)}
              <button class:selected={selected===r.id} class:review={r.needsReview} aria-pressed={selected===r.id} disabled={busy||drawing||splitting}
                style={`left:${r.x/image.naturalWidth*100}%;top:${r.y/image.naturalHeight*100}%;width:${r.width/image.naturalWidth*100}%;height:${r.height/image.naturalHeight*100}%`}
                aria-label={`選取文字框 ${r.order+1}${r.needsReview?'，待核對':''}`} title={`文字框 ${r.order+1}`} onclick={()=>{selectRegion(r.id);panel='text';}}><span>{r.order+1}</span></button>
            {/each}
          </div>
        {/if}
      </div>
    </section>
    {#if image}
      <aside aria-label="單框校正">
        <div class="panel-title"><h2>單框校正</h2><small class="mx-note">{regions.length} 個文字框</small></div>
        {#if regions.length}
          <select class="frame-select" aria-label="選擇文字框" disabled={busy}
            value={selected} onchange={e=>selectRegion(e.currentTarget.value)}>
            {#each regions as r}<option value={r.id}>{r.order+1} · {r.needsReview?'待核對 · ':''}{r.source.slice(0,18)||'尚未辨識'}</option>{/each}
          </select>
        {/if}
        {#if active}
          <div class="segmented mx-segments" role="group" aria-label="校正項目">
            <button aria-pressed={panel==='text'} onclick={()=>panel='text'}>文字</button>
            <button aria-pressed={panel==='layout'} onclick={()=>panel='layout'}>排版</button>
          </div>
          {#if panel==='text'}
            <div class="source-editor">
              <label>日文原文<textarea lang="ja" rows="2" value={active.source} oninput={e=>update('source',e.currentTarget.value)} disabled={busy}></textarea></label>
              {#if cropUrl}<img class="ocr-crop" src={cropUrl} alt="選定文字框原始裁圖" />{/if}
            </div>
            <label>繁中譯文<textarea rows="2" value={active.translation} oninput={e=>update('translation',e.currentTarget.value)} disabled={busy}></textarea></label>
            {#each active.warnings as warning}<p class="mx-warning">{warning}</p>{/each}
            <div class="row">
              <button disabled={busy} onclick={()=>action(()=>compare(currentOcrProfile))}>重新辨識此框</button>
              <button disabled={busy} title={`約 ${Math.ceil(ocrBytes(otherProfile)/1048576)} MiB，首次比較會準備模型`} onclick={()=>action(()=>compare(otherProfile))}>使用另一模式比較</button>
            </div>
            {#if candidate}
              <section class="candidate" aria-label="OCR 候選比較">
                <div class="panel-title"><h3>OCR 候選</h3><small class="mx-note">{candidate.profile==='fp32'?'全精度':candidate.profile==='int8'?'INT8':'舊結果'}</small></div>
                <div class="candidate-reading" role="region" aria-label="候選文字與差異">
                  <p lang="ja" class="candidate-text">{#if !candidate.source}（空結果）{:else}{difference.prefix}{#if difference.added}<mark>{difference.added}</mark>{/if}{difference.suffix}{/if}</p>
                  {#if difference.removed}<p class="mx-note removed">原文差異 <del lang="ja">{difference.removed}</del></p>{/if}
                  {#each candidate.warnings as warning}<small class="mx-note">{warning}</small>{/each}
                </div>
                {#if candidate.source===active.source}<p class="mx-note">文字相同，採用後保留譯文。</p>
                {:else if !candidate.source}<p class="mx-warning">採用後將清空這一框的原文與譯文</p>
                {:else}<p class="mx-warning">採用後，此框需要重新翻譯</p>{/if}
                <button disabled={busy} onclick={()=>action(()=>chooseCandidate(active!.ocrCandidates!.length-1))}>{candidate.source?'採用新原文':'採用空結果'}</button>
                {#if active.ocrCandidates?.length===2&&active.source!==active.ocrCandidates[0].source}
                  <details><summary>先前原文候選</summary><p lang="ja">{active.ocrCandidates[0].source||'（空結果）'}</p><button disabled={busy} onclick={()=>action(()=>chooseCandidate(0))}>採用先前原文</button></details>
                {/if}
              </section>
            {/if}
            {#if active.initialTranslation!==undefined}
              <details><summary>Google 初譯</summary><p>{active.initialTranslation}</p><button disabled={busy} onclick={()=>update('translation',active!.initialTranslation!)}>還原此框初譯</button></details>
            {/if}
          {:else}
            <label>呈現方式<select value={active.render} disabled={busy} onchange={e=>update('render',e.currentTarget.value)}><option value="auto">字形白底／局部遮蓋原文</option><option value="overlay">字形白底（浮層）</option><option value="rectangle">矩形浮層（舊方式）</option><option value="fill">手動確認擦成白底</option></select></label>
            <label>中文方向<select value={active.textDirection??'auto'} disabled={busy} onchange={e=>update('textDirection',e.currentTarget.value)}><option value="auto">自動橫／直排</option><option value="horizontal">橫排</option><option value="vertical">直排（右至左）</option></select></label>
            <label>字級倍率 {(active.fontScale??1).toFixed(1)}×<input aria-label="字級倍率" type="range" min="0.5" max="2" step="0.1" value={active.fontScale??1} disabled={busy} oninput={e=>update('fontScale',Number(e.currentTarget.value))}></label>
            <div class="coords">{#each [['x','X'],['y','Y'],['width','寬'],['height','高'],['order','順序']] as [field,label]}<label>{label}<input type="number" aria-label={field} value={active[field as 'x'|'y'|'width'|'height'|'order']} disabled={busy} onchange={e=>{if(Number.isFinite(e.currentTarget.valueAsNumber))update(field as keyof Region,Math.max(0,e.currentTarget.valueAsNumber));}}></label>{/each}</div>
            {#each active.warnings.filter(w=>/^原文清除需校正|^中文空間不足/.test(w)) as warning}<p class="mx-warning">{warning}</p>{/each}
          {/if}
          <details class="frame-tools" open={splitting}>
            <summary>文字框工具</summary>
            <div class="row">
              <button disabled={busy} aria-pressed={splitting} onclick={()=>{if(splitting){clearSplit();return;}splitting=true;drawing=false;splitAxis='x';splitPercent=50;}}>拆框</button>
              <button disabled={busy||!regions.some(r=>r.order===active!.order+1)} onclick={()=>action(merge)}>合併下一框</button>
              <button class="danger" disabled={busy} onclick={()=>action(remove)}>刪除此框</button>
            </div>
            {#if splitting}
              <section class="split-form" aria-label="拆框預覽">
                <p>分割後須重新辨識兩個新框。可在漫畫上拖曳，或輸入位置。</p>
                <label>分割方向<select aria-label="分割方向" value={splitAxis} disabled={busy} onchange={e=>{splitAxis=e.currentTarget.value==='x'?'x':'y';splitPreview=undefined;}}><option value="x">垂直分割（右框優先）</option><option value="y">水平分割（上框優先）</option></select></label>
                <label>分割位置（框內 %）<input aria-label="分割位置（框內百分比）" type="number" min="1" max="99" step="1" value={splitPercent} disabled={busy} oninput={e=>{splitPercent=e.currentTarget.valueAsNumber;splitPreview=undefined;}}></label>
                {#if splitPreview}<p role="status">{splitPreview.axis==='x'?'1 右框 → 2 左框':'1 上框 → 2 下框'}</p>{/if}
                <div class="row">
                  <button disabled={busy||!Number.isFinite(splitPercent)||splitPercent<1||splitPercent>99} onclick={previewSplitAtPercent}>預覽拆框</button>
                  <button disabled={busy||!splitPreview} onclick={()=>action(applySplit)}>套用拆框</button>
                  <button disabled={busy} onclick={clearSplit}>取消拆框</button>
                </div>
              </section>
            {/if}
          </details>
          <details><summary>辨識來源與信心</summary>
            <p class="mx-note">偵測分數 {active.score.toFixed(3)} · OCR 信心 {active.ocr?.confidence===undefined?'未提供':active.ocr.confidence.toFixed(3)}</p>
            <p class="mx-note">{active.ocr?`${active.ocr.profile} / ${active.ocr.decoder} / ${active.ocr.backend}`:'手動或舊結果，OCR 來源未標記'}</p>
            <p class="mx-note">另一模式約 {Math.ceil(ocrBytes(otherProfile)/1048576)} MiB，首次比較會準備模型。</p>
          </details>
        {:else}
          <p class="mx-note">偵測或手動框選後，就能在這裡校正文字。</p>
        {/if}
        {#if legacy.length}
          <details><summary>{legacy.length} 份舊版結果</summary>
            <p class="mx-note">可載入舊結果。整頁重辨識會使用目前的模型身分保存。</p>
            {#each legacy as page,index}<button disabled={busy} onclick={()=>action(()=>restoreLegacy(page))}>載入舊結果 {index+1}</button>{/each}
          </details>
        {/if}
        <details><summary>本頁執行紀錄</summary>
          <p class="mx-note">{backend} · {fontReady?'繁中字型就緒':'使用系統字型'}</p>
          {#each diagnostics as d}<p class="diagnostic">{d.message}<small>{d.backend??''} {d.model??''} {d.ms?`${Math.round(d.ms)} ms`:''}</small></p>{/each}
          <small class="mx-note">{config.backend==='google-web'?'Google 網頁翻譯只接收 OCR 文字，圖片與嵌字留在本機。':config.backend==='gemini-web'?'匿名 Gemini 接收 OCR 文字、術語與前頁摘要，圖片與嵌字留在本機。':'目前使用本機翻譯。首次使用可能需要下載模型。'}</small>
        </details>
      </aside>
    {/if}
  </div>

  {#if image||busy||message}
    <footer aria-label="校正狀態及套用">
      <div class="status" class:status-failed={saveFailed} class:status-pending={saving>0||dirty&&!!siteInput} role="status">
        {#if image}<strong>{saveFailed?'校正儲存失敗':saving?'正在儲存校正…':dirty&&siteInput?'校正已儲存 · 漫畫頁待更新':dirty?'校正已儲存':siteInput?'漫畫頁譯圖可在此更新':'本機圖片已載入'}</strong>{/if}
        {#if message}<small class="mx-note">{message}</small>{/if}
      </div>
      <div class="footer-actions">
        {#if busy}<button disabled={committing} onclick={()=>aborter?.abort()}>取消</button>{/if}
        {#if undo}<button disabled={busy} onclick={()=>action(undoEdit)}>撤銷{undo.label}</button>{/if}
        {#if saveFailed}<button disabled={busy} onclick={()=>action(save)}>重試儲存</button>{/if}
        {#if image}
          <details class="menu export"><summary>匯出</summary><div class="menu-items">
            <button disabled={!canvas||busy} onclick={()=>canvas?.toBlob(b=>{if(b)download(b,`${filename}-translated.png`);},'image/png')}>匯出 PNG</button>
            <button disabled={busy} onclick={exportJson}>匯出校正 JSON</button>
          </div></details>
          {#if parent!==window||onSiteApply}<button class="primary" disabled={!canvas||busy||saving>0||saveFailed} onclick={()=>action(applyToPage)}>套用至漫畫頁</button>{/if}
        {/if}
      </div>
    </footer>
  {/if}

  <dialog bind:this={rerunDialog} aria-labelledby="rerun-title" oncancel={e=>{e.preventDefault();e.stopPropagation();closeRerun();}}>
    <h2 id="rerun-title">{rerun==='detect'?'重偵測整張圖片？':'重辨識整張圖片？'}</h2>
    <p>{rerun==='detect'?'成功後會重新建立這張圖的文字框，取代現有框選及排版。':'成功後會以 OCR 結果更新這張圖的原文，清除原有候選及譯文。'}</p>
    <p>範圍為這張圖的 {regions.length} 個框，含 {regions.filter(r=>r.source.trim()).length} 框原文與 {regions.filter(r=>r.translation.trim()).length} 框譯文。完成後可在這張圖撤銷一次。</p>
    <div class="row">
      <button onclick={closeRerun}>保留目前校正</button>
      <button class="danger" onclick={()=>{const kind=rerun;closeRerun();if(kind)void action(()=>rerunPage(kind),'已取消，原結果已保留');}}>{rerun==='detect'?'確認重偵測':'確認重辨識'}</button>
    </div>
  </dialog>
</main>

<style>
  :global(body) { margin: 0; background: #eef1e9; }
  main { width: 100%; max-width: 1540px; min-height: 100vh; margin: auto; background: var(--mx-paper); display: flex; flex-direction: column; }
  main.site { max-width: none; height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
  .top { padding: 14px 20px 9px; border-bottom: 1px solid var(--mx-line); }
  header, .heading, .toolbar, .row, .panel-title, .footer-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  header { justify-content: space-between; gap: 8px 14px; }
  h1 { font-size: clamp(20px, 2.5vw, 28px); margin: 0; line-height: 1.2; }
  h2 { font-size: 16px; margin: 0; }
  h3 { font-size: 14px; margin: 0; }
  .page-count { border: 1px solid var(--mx-line); border-radius: 14px; padding: 3px 9px; font-size: 12px; color: var(--mx-muted); }
  .navigation-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 9px; }
  .pager { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .top .mx-alert, .access p { margin: 7px 0 0; }
  .workspace { flex: 1; display: grid; align-items: start; grid-template-columns: minmax(0, 1fr) minmax(300px, 355px); gap: 12px; padding: 12px; }
  .workspace.has-chapter { grid-template-columns: 104px minmax(0, 1fr) minmax(300px, 355px); align-items: stretch; min-height: 0; }
  .rail, .stage, aside { min-width: 0; border: 1px solid var(--mx-line); border-radius: 10px; }
  .rail { overflow: auto; padding: 8px; background: var(--mx-tint); }
  .rail button { width: 100%; padding: 4px; display: grid; gap: 3px; justify-items: center; margin: 0 0 6px; font-size: 12px; }
  .rail button[aria-current=page] { background: var(--mx-hover); border-color: var(--mx-green); box-shadow: inset 0 0 0 1px var(--mx-green); font-weight: 700; }
  .rail button img { width: 100%; max-height: 92px; object-fit: contain; background: var(--mx-canvas); }
  .rail b { font-size: 10px; color: var(--mx-review); }
  .stage { background: var(--mx-canvas); padding: 10px clamp(8px, 2vw, 30px) 18px; overflow: auto; }
  .view-controls { width: max-content; max-width: 100%; margin: 0 auto 12px; }
  .view-controls button { min-width: 66px; }
  .row button[aria-pressed=true], .menu-items button[aria-pressed=true] { background: var(--mx-hover); border-color: var(--mx-green); font-weight: 650; }
  .paper { width: min(100%, 780px); margin: 0 auto; position: relative; box-shadow: var(--mx-shadow); background: var(--mx-surface); }
  .image-wrap { width: 100%; }
  .image-wrap :global(canvas) { display: block; width: 100%; height: auto; }
  .drawing { cursor: crosshair; touch-action: none; }
  .regions { inset: 0; position: absolute; pointer-events: none; }
  .regions button { position: absolute; min-height: 0; pointer-events: auto; border: 1px solid #4d7b6460; background: transparent; border-radius: 2px; padding: 0; }
  .regions button:disabled { pointer-events: none; opacity: 1; }
  .regions button:hover:not(:disabled) { background: #5d997628; border-color: #2d684b; }
  .regions button.review { border-color: #a06a2d; border-style: dashed; }
  .regions button.selected { border: 2px solid #a06223; outline: 1px solid #fff; }
  .regions span, .split-guide span { position: absolute; top: 0; left: 0; background: var(--mx-green); color: #fff; font-size: 11px; padding: 0 4px; }
  .regions .selected span, .split-guide span { background: var(--mx-review); }
  .split-guide { position: absolute; z-index: 1; border: 2px dashed #8c521a; background: #fff1d933; pointer-events: none; }
  aside { padding: 14px; background: var(--mx-surface); overflow: auto; }
  .panel-title { justify-content: space-between; }
  .frame-select { width: 100%; margin: 9px 0; }
  .segmented { margin-bottom: 9px; }
  label { display: block; min-width: 0; font-size: 13px; font-weight: 550; margin: 6px 0 10px; }
  label :where(input, select, textarea) { display: block; width: 100%; margin-top: 3px; font-weight: 400; }
  textarea { resize: vertical; line-height: 1.55; }
  .source-editor { display: flex; gap: 8px; align-items: end; }
  .source-editor label { flex: 1; }
  .ocr-crop { width: 23%; height: 63px; object-fit: contain; background: var(--mx-paper); border: 1px solid var(--mx-line); border-radius: 6px; margin-bottom: 10px; }
  .candidate { border: 1px solid var(--mx-line); border-inline-start: 3px solid var(--mx-green); border-radius: 10px; background: var(--mx-tint); padding: 11px; margin-top: 11px; }
  .candidate-reading { max-block-size: min(11rem, 26dvh); overflow: auto; overscroll-behavior: contain; overflow-wrap: anywhere; }
  .candidate-reading:focus-visible { outline: 2px solid var(--mx-green); outline-offset: -2px; border-radius: 4px; }
  .candidate-text { white-space: pre-wrap; margin: 7px 0; }
  .candidate mark { background: #ffe2a4; color: #503110; }
  .candidate .removed { overflow-wrap: anywhere; font-size: 12px; }
  .candidate-reading small, .diagnostic small { display: block; }
  .candidate-reading small { margin-bottom: 4px; }
  .candidate details p { max-block-size: 8rem; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; }
  .coords { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .split-form { margin-top: 7px; border-left: 2px solid var(--mx-border); padding-left: 10px; }
  aside details { margin-top: 10px; border-top: 1px solid var(--mx-line); padding-top: 7px; }
  aside .row { margin-top: 6px; }
  footer { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 7px 14px; margin-top: auto; padding: 11px 16px; border-top: 1px solid var(--mx-line); background: var(--mx-paper); box-shadow: 0 -6px 18px #1b332909; }
  .status { min-width: 0; padding-inline-start: 9px; border-inline-start: 3px solid var(--mx-green); }
  .status-pending { border-inline-start-color: #a56725; }
  .status-failed { border-inline-start-color: var(--mx-danger); }
  .status small { display: block; }
  .menu { position: relative; z-index: 3; }
  .menu summary { border: 1px solid var(--mx-border); border-radius: 7px; background: var(--mx-surface); padding: 6px 10px; min-height: 36px; }
  .menu-items { position: absolute; z-index: 4; left: 0; top: calc(100% + 4px); width: max-content; max-width: min(280px, 76vw); display: grid; gap: 5px; background: var(--mx-surface); border: 1px solid var(--mx-border); border-radius: 9px; padding: 8px; box-shadow: 0 7px 22px #22392e21; }
  .export .menu-items { top: auto; bottom: calc(100% + 4px); left: auto; right: 0; }
  .empty { text-align: center; padding: clamp(28px, 7vw, 84px) 14px; }
  .empty h2 { font-size: 24px; }
  .empty small { display: block; margin-top: 12px; }
  .empty-reader .workspace { display: block; }
  .empty-reader .stage { max-width: 690px; margin: 5vh auto; }
  .visually-hidden { position: absolute; clip-path: inset(50%); overflow: hidden; height: 1px; width: 1px; white-space: nowrap; }
  dialog { width: min(420px, calc(100% - 26px)); padding: 18px; }
  @media (max-width: 900px) {
    .rail { display: none; }
    .workspace.has-chapter { grid-template-columns: minmax(0, 1fr) minmax(280px, .8fr); }
  }
  @media (max-width: 660px) {
    .top { padding: 8px; }
    .workspace, .workspace.has-chapter { grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 8px; align-content: start; overflow: auto; }
    .stage { max-height: 45vh; }
    .empty-reader .stage { max-height: none; }
    aside { padding: 12px; }
    .toolbar { position: relative; }
    .toolbar .menu { position: static; }
    footer { padding: 8px; }
    .footer-actions { margin-left: auto; }
  }
</style>
