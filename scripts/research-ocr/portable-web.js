import * as ort from 'onnxruntime-web';
export async function runPortable(){
 const metadata=await(await fetch('/data/portable/result.json')).json();
 const result={variant:'portable',status:'running',backend:'ONNX Runtime Web WASM single-thread',runtime:ort.env.versions,results:[],performance:[],scope:'controlled single-line images, including one bounded preprocessing variant; not full manga OCR'};
 if(!metadata.onnxModel){result.status='not-applicable-no-converted-model';return result;}
 const started=performance.now();const session=await ort.InferenceSession.create('/data/'+metadata.onnxModel,{executionProviders:['wasm']});result.initMs=performance.now()-started;
 const scoreName=metadata.samples[0].scoreOutputName;
 const labels=await(await fetch('/data/portable/labels.json')).json(),blank=metadata.labelMap.blankId;
 try{
  for(const sample of metadata.samples){
   const bytes=new Uint8Array(await(await fetch('/data/'+sample.tensor)).arrayBuffer());
   const tensor=new ort.Tensor('uint8',bytes,[1,32,168,1]);const begin=performance.now();const outputs=await session.run({[session.inputNames[0]]:tensor});
   const scores=outputs[scoreName];if(!scores)throw Error('Cannot map score output');const classes=scores.dims.at(-1),ids=[];
   for(let i=0;i<scores.data.length/classes;i++){let best=0;for(let j=1;j<classes;j++)if(scores.data[i*classes+j]>scores.data[i*classes+best])best=j;ids.push(best);}
   const collapsed=ids.filter((token,j)=>j===0||token!==ids[j-1]),source=collapsed.filter(token=>token!==blank).map(token=>labels[token]??'?').join('').trim();
   result.results.push({id:sample.id,reference:sample.reference,source,tfliteSource:sample.source,ms:performance.now()-begin,greedyIds:ids,argmaxParity:JSON.stringify(ids)===JSON.stringify(sample.greedyIds),outputs:Object.fromEntries(Object.entries(outputs).map(([k,v])=>[k,{shape:v.dims,type:v.type}]))});
   tensor.dispose();Object.values(outputs).forEach(t=>t.dispose());
  }
  result.status='complete';return result;
 }catch(error){result.status='failed';result.error=String(error);return result;}
 finally{await session.release();}
}
