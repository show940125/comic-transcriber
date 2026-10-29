import * as ort from 'onnxruntime-web';
import {runPortable} from './portable-web';
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths=location.origin+'/ort/';
ort.env.wasm.proxy=false;
const get=async p=>{const r=await fetch(p);if(!r.ok)throw Error(`${r.status}: ${p}`);return r;};
window.runResearch=async config=>{
 const {variant,key=variant,threads=1,selection='all',preprocessing='frozen'}=typeof config==='string'?{variant:config}:config;
 ort.env.wasm.numThreads=threads;
 if(threads>1&&!crossOriginIsolated)throw Error('Multi-thread run requires cross-origin isolation; no silent fallback');
 const spawnedWorkers=[],PlatformWorker=globalThis.Worker;
 globalThis.Worker=class extends PlatformWorker{constructor(url,options){super(url,options);spawnedWorkers.push({name:options?.name??'',url:String(url)});}};
 if(variant==='portable'){const result=await runPortable();await fetch('/checkpoint',{method:'POST',body:JSON.stringify(result)});return result;}
 const dataset=await(await get('/data/dataset.json')).json();
 const refs=await(await get('/data/references.json')).json();if(refs.status!=='frozen-before-inference')throw Error('References must be frozen');
 const quantEncoder=['int8','hybrid','qint8','quint8'].includes(variant),kv=['kv','hybrid','qint8','quint8'].includes(variant);
 const modelBase=quantEncoder?'/data/models/int8/':'/baseline/',kvBase='/data/models/'+(['qint8','quint8'].includes(variant)?variant:'kv')+'/';
 const started=performance.now();
 const encoder=await ort.InferenceSession.create(modelBase+(quantEncoder?'encoder_model_int8.onnx':'encoder_model.onnx'),{executionProviders:['wasm']});
 const decoder=await ort.InferenceSession.create(kv?kvBase+'decoder_kv.onnx':modelBase+(variant==='int8'?'decoder_model_int8.onnx':'decoder_model.onnx'),{executionProviders:['wasm']});
 const crossSession=kv?await ort.InferenceSession.create(kvBase+'cross_kv.onnx',{executionProviders:['wasm']}):null;
 const vocab=(await(await get('/baseline/vocab.txt')).text()).trimEnd().split(/\r?\n/);
 const rows=selection==='sample'?dataset.records.filter(r=>dataset.sample.includes(r.id)):dataset.records;
 const result={variant:key,modelVariant:variant,preprocessing,status:'running',backend:`ONNX Runtime Web WASM requested threads=${threads}`,requestedThreads:threads,spawnedWorkers,runtime:ort.env.versions,initMs:performance.now()-started,crossOriginIsolated,results:[],performance:[],expectedRows:rows.length};
 const tensors=new Map();
 const infer=async row=>{
  const begin=performance.now(),tokens=[2],steps=[];
  if(preprocessing!=='canvas'&&row.skipBlank)return {id:row.id,source:'',tokens,ended:true,skippedBlank:true,ms:performance.now()-begin};
  if(!tensors.has(row.id)){
   if(preprocessing==='canvas'){
    const bitmap=await createImageBitmap(await(await get('/data/'+row.crop)).blob()),canvas=new OffscreenCanvas(224,224),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0,224,224);bitmap.close();
    const rgba=ctx.getImageData(0,0,224,224).data,values=new Float32Array(3*224*224);let dark=0,light=0;
    for(let i=0;i<224*224;i++){const gray=rgba[i*4]*.299+rgba[i*4+1]*.587+rgba[i*4+2]*.114;if(gray<100)dark++;if(gray>155)light++;for(let c=0;c<3;c++)values[c*224*224+i]=(gray/255-.5)*2;}
    tensors.set(row.id,{values,skip:dark<24||light<24});
   }else tensors.set(row.id,{values:new Float32Array(await(await get('/data/'+row.tensor)).arrayBuffer()),skip:false});
  }
  if(tensors.get(row.id).skip)return {id:row.id,source:'',tokens,ended:true,skippedBlank:true,ms:performance.now()-begin};
  const tensor=new ort.Tensor('float32',tensors.get(row.id).values,[1,3,224,224]);
  const encoded=await encoder.run({[encoder.inputNames[0]]:tensor}),hidden=encoded[encoder.outputNames[0]];
  let cross=null,past=null,ended=false;
  if(crossSession){const out=await crossSession.run({encoder_hidden_states:hidden});cross=out[crossSession.outputNames[0]];past=new ort.Tensor('float32',new Float32Array(4*12*64),[4,1,12,1,64]);}
  for(let n=0;n<64;n++){
   const ids=new ort.Tensor('int64',BigInt64Array.from((kv?[tokens.at(-1)]:tokens).map(BigInt)),[1,kv?1:tokens.length]);
   const feeds={};let beam=null;
   if(kv){beam=new ort.Tensor('int64',BigInt64Array.from([0n]),[1]);Object.assign(feeds,{input_ids:ids,beam_idx:beam,past_key_values:past,cross_key_values:cross});}
   else for(const name of decoder.inputNames)feeds[name]=/encoder|hidden/.test(name)?hidden:ids;
   const output=await decoder.run(feeds),logits=output[decoder.outputNames[0]],size=logits.dims.at(-1),start=logits.data.length-size;
   let token=0;for(let j=1;j<size;j++)if(logits.data[start+j]>logits.data[start+token])token=j;
   steps.push({token,maxLogit:Number(logits.data[start+token])});
   ids.dispose();beam?.dispose();
   if(kv){past.dispose();past=output[decoder.outputNames[1]];for(const [key,value] of Object.entries(output))if(value!==past)value.dispose();}
   else Object.values(output).forEach(t=>t.dispose());
   if(token===3){ended=true;break;}tokens.push(token);
  }
  past?.dispose();cross?.dispose();tensor.dispose();Object.values(encoded).forEach(t=>t.dispose());
  const source=tokens.slice(1).filter(t=>t>=5).map(t=>vocab[t]??'').join('').replace(/##|\[UNK\]/g,'').replace(/\s+/g,'');
  return {id:row.id,source,tokens,steps,ended,truncated:!ended,ms:performance.now()-begin};
 };
 const checkpoint=async()=>{document.querySelector('#status').textContent=`${key}: ${result.results.length}/${rows.length}`;await fetch('/checkpoint',{method:'POST',body:JSON.stringify(result)});};
 try{
  for(const row of rows){result.results.push(await infer(row));if(result.results.length%20===1)await checkpoint();}
  for(let run=1;run<=3;run++){const rows=[];for(const id of dataset.sample)rows.push(await infer(dataset.records.find(r=>r.id===id)));result.performance.push({run,warm:true,totalMs:rows.reduce((a,r)=>a+r.ms,0),rows:rows.map(({id,ms,source})=>({id,ms,source}))});await checkpoint();}
  result.status='complete';result.totalMs=performance.now()-started;await checkpoint();return result;
 }catch(error){result.status='failed';result.error=String(error);await checkpoint();return result;}
 finally{await encoder.release();await decoder.release();if(crossSession)await crossSession.release();}
};
