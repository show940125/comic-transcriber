import * as ort from 'onnxruntime-web/webgpu';
export interface MangaSession {session:Pick<ort.InferenceSession,'inputNames'|'outputNames'>;backend:string}
// WASM run() may resolve synchronously. Yield a task (not only a microtask)
// so queued Worker cancellation messages can update the AbortSignal.
export async function yieldForCancellation(signal:AbortSignal){
  signal.throwIfAborted();
  await new Promise<void>(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);});
  signal.throwIfAborted();
}
export async function decodeManga<T extends MangaSession>(encoder:T,decoder:T,cross:T|undefined,input:ort.Tensor,signal:AbortSignal,run:(value:T,feeds:Record<string,ort.Tensor>,signal:AbortSignal)=>Promise<Record<string,ort.Tensor>>){
  const owned=new Set<ort.Tensor>();
  const own=(t:ort.Tensor)=>{owned.add(t);return t;};
  const free=(t:ort.Tensor|undefined)=>{if(t&&owned.delete(t))t.dispose();};
  const tokens=[2],steps:number[]=[];let ended=false;
  try{
    const encoded=await run(encoder,{[encoder.session.inputNames[0]]:input},signal);Object.values(encoded).forEach(own);
    const hidden=encoded[encoder.session.outputNames[0]];let past:ort.Tensor|undefined,crossTensor:ort.Tensor|undefined;
    if(cross){
      const values=await run(cross,{encoder_hidden_states:hidden},signal);Object.values(values).forEach(own);crossTensor=values[cross.session.outputNames[0]];
      past=own(new ort.Tensor('float32',new Float32Array(4*12*64),[4,1,12,1,64]));
    }
    for(let n=0;n<64;n++){
      if(n%8===0)await yieldForCancellation(signal);else signal.throwIfAborted();
      const ids=own(new ort.Tensor('int64',BigInt64Array.from((cross?[tokens.at(-1)!]:tokens).map(BigInt)),[1,cross?1:tokens.length]));
      let beam:ort.Tensor|undefined;const feeds:Record<string,ort.Tensor>={};
      if(cross){beam=own(new ort.Tensor('int64',BigInt64Array.from([0n]),[1]));Object.assign(feeds,{input_ids:ids,beam_idx:beam,past_key_values:past!,cross_key_values:crossTensor!});}
      else for(const name of decoder.session.inputNames)feeds[name]=/encoder|hidden/i.test(name)?hidden:ids;
      const output=await run(decoder,feeds,signal);Object.values(output).forEach(own);
      const logits=output[decoder.session.outputNames[0]],size=logits.dims.at(-1)!,offset=logits.data.length-size;
      let token=0;for(let j=1;j<size;j++)if(Number(logits.data[offset+j])>Number(logits.data[offset+token]))token=j;
      steps.push(token);free(ids);free(beam);
      if(cross){free(past);past=output[decoder.session.outputNames[1]];}
      for(const value of Object.values(output))if(value!==past)free(value);
      if(token===3){ended=true;break;}tokens.push(token);
    }
    signal.throwIfAborted();return {tokens,steps,ended};
  }finally{for(const tensor of owned)tensor.dispose();owned.clear();}
}
