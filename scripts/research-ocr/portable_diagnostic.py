"""One bounded backend diagnostic: TFLite reference kernels vs XNNPACK vs ORT."""
import os
os.environ['CUDA_VISIBLE_DEVICES']='-1'
import json
from pathlib import Path
import numpy as np
import tensorflow as tf
import onnxruntime as ort
from prepare import OUT,save

report=json.loads((OUT/'portable/result.json').read_text('utf-8'))
source=Path.home()/'AppData/Local/Google/Chrome/User Data/screen_ai/153.4/gocr/gocr_models/line_recognition_mobile_convnext320_omni/hanijpan.tflite'
reference=tf.lite.Interpreter(model_path=str(source),num_threads=1,experimental_op_resolver_type=tf.lite.experimental.OpResolverType.BUILTIN_REF)
reference.allocate_tensors();inputs=reference.get_input_details();outputs=reference.get_output_details()
options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
session=ort.InferenceSession(str(OUT/report['onnxModel']),sess_options=options,providers=['CPUExecutionProvider'])
rows=[]
for index,sample in enumerate(report['samples']):
    tensor=np.fromfile(OUT/sample['tensor'],dtype=np.uint8).reshape(1,32,168,1)
    reference.set_tensor(inputs[0]['index'],tensor);reference.invoke()
    values={r['name']:reference.get_tensor(r['index']) for r in outputs}
    old=np.load(OUT/f'portable/line-{index}-tflite.npz');actual=session.run(None,{session.get_inputs()[0].name:tensor})
    row={'id':sample['id'],'referenceVsXnnpack':[],'referenceVsOnnx':[]}
    for spec,value in zip(session.get_outputs(),actual):
        ref=values[spec.name];prior=old[spec.name]
        row['referenceVsXnnpack'].append({'name':spec.name,'maxAbsoluteDifference':float(np.abs(ref.astype(float)-prior.astype(float)).max())})
        row['referenceVsOnnx'].append({'name':spec.name,'maxAbsoluteDifference':float(np.abs(ref.astype(float)-value.astype(float)).max())})
    rows.append(row)
save('portable/backend-diagnostic.json',{'status':'complete','scope':'single bounded backend isolation; no kernel rewrite','rows':rows})
print(json.dumps(rows))
