"""Bounded, reproducible KV weight quantization; no private input calibration."""
import argparse,json,time,copy
import onnx
import onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic,QuantType
from prepare import OUT,sha,save

p=argparse.ArgumentParser();p.add_argument('--unsigned',action='store_true');args=p.parse_args()
recipe='quint8' if args.unsigned else 'qint8';dest=OUT/'models'/recipe;dest.mkdir(parents=True,exist_ok=True)
receipt={'recipe':recipe,'runtime':ort.__version__,'parameters':{'op_types_to_quantize':['MatMul'],'weight_type':recipe,'per_channel':False,'reduce_range':False,'MatMulConstBOnly':True},'models':[],'status':'running'}
try:
    for name in ['cross_kv.onnx','decoder_kv.onnx']:
        source=OUT/'models/kv'/name;target=dest/name;started=time.perf_counter()
        # ORT's Gemm-to-MatMul preprocessing transposes shared initializers in place.
        # The tied output projection shares word.weight with Gather; clone only the
        # Gemm input so its transpose cannot corrupt the embedding lookup.
        graph=onnx.load(source);initializers={t.name:t for t in graph.graph.initializer};cloned=[]
        for index,node in enumerate(graph.graph.node):
            if node.op_type=='Gemm' and node.input[1] in initializers:
                name=node.input[1];clone=copy.deepcopy(initializers[name]);clone.name=f'{name}__gemm_copy_{index}';graph.graph.initializer.append(clone);node.input[1]=clone.name;cloned.append(name)
        prepared=dest/(source.stem+'-prepared.onnx')
        onnx.save(graph,prepared)
        quantize_dynamic(str(prepared),str(target),op_types_to_quantize=['MatMul'],weight_type=QuantType.QUInt8 if args.unsigned else QuantType.QInt8,per_channel=False,reduce_range=False,extra_options={'MatMulConstBOnly':True})
        session=ort.InferenceSession(str(target),providers=['CPUExecutionProvider'])
        receipt['models'].append({'name':source.name,'clonedGemmWeights':cloned,'sourceSha256':sha(source),'sha256':sha(target),'bytes':target.stat().st_size,'seconds':time.perf_counter()-started,'inputs':[{'name':i.name,'shape':i.shape,'type':i.type} for i in session.get_inputs()]})
    receipt['status']='complete'
except Exception as error:
    receipt.update(status='failed',error=repr(error));raise
finally:
    save(f'combo/quantize-{recipe}.json',receipt)
    print(json.dumps(receipt,ensure_ascii=False))
