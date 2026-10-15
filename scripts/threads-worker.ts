// Benchmark-only worker: identical tensors are persisted for the native runner.
import * as ort from 'onnxruntime-web/webgpu';
let pthreads=0;const PlatformWorker=Worker;
globalThis.Worker=class extends PlatformWorker{constructor(url:string|URL,options?:WorkerOptions){super(url,options);if(options?.name==='em-pthread')pthreads++;}};
onmessage=async({data})=>{try{
 ort.env.wasm.wasmPaths=location.origin+'/ort/';ort.env.wasm.numThreads=data.threads;
 const started=performance.now(),encoder=await ort.InferenceSession.create('/models/manga-ocr/encoder_model.onnx',{executionProviders:['wasm']}),decoder=await ort.InferenceSession.create('/models/manga-ocr/decoder_model.onnx',{executionProviders:['wasm']}),initMs=performance.now()-started;
 const inputs=await Promise.all(data.files.map(async(file:string)=>{const response=await fetch('/tensors/'+file);const buffer:ArrayBuffer=await response.arrayBuffer();return new Float32Array(buffer);}));
 const results=[];
 for(let run=0;run<4;run++){const timings=[],tokens=[];for(const input of inputs){
  const begin=performance.now(),tensor=new ort.Tensor('float32',input,[1,3,224,224]),encoded=await encoder.run({[encoder.inputNames[0]]:tensor}),hidden=encoded[encoder.outputNames[0]],ids=[2];
  for(let n=0;n<64;n++){const tokenTensor=new ort.Tensor('int64',BigInt64Array.from(ids.map(BigInt)),[1,ids.length]),feeds:Record<string,ort.Tensor>={};for(const name of decoder.inputNames)feeds[name]=/encoder|hidden/.test(name)?hidden:tokenTensor;
   const out=await decoder.run(feeds),logits=out[decoder.outputNames[0]],size=logits.dims.at(-1)!,offset=logits.data.length-size;let best=0;for(let i=1;i<size;i++)if(Number(logits.data[offset+i])>Number(logits.data[offset+best]))best=i;
   tokenTensor.dispose();Object.values(out).forEach(t=>t.dispose());if(best===3)break;ids.push(best);
  }timings.push(performance.now()-begin);tokens.push(ids);tensor.dispose();Object.values(encoded).forEach(t=>t.dispose());
 }results.push({run,cold:run===0,timings,tokens});postMessage({type:'progress',threads:data.threads,run});}
 await encoder.release();await decoder.release();postMessage({ok:true,threads:data.threads,pthreads,crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer!=='undefined',initMs,results});
}catch(error){postMessage({ok:false,threads:data.threads,error:String(error),pthreads,crossOriginIsolated});}};
