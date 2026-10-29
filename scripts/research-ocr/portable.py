"""Bounded TFLite conversion and numerical/greedy-decoder probe. No DLL reverse engineering."""
import importlib.util,json,os,subprocess,sys,time
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw,ImageFont,ImageOps
from prepare import ROOT,OUT,save,sha

def main():
    os.environ['CUDA_VISIBLE_DEVICES']='-1'
    import tensorflow as tf
    import onnxruntime as ort
    directory=OUT/'portable';directory.mkdir(exist_ok=True)
    source=Path.home()/'AppData/Local/Google/Chrome/User Data/screen_ai/153.4/gocr/gocr_models/line_recognition_mobile_convnext320_omni'
    model=source/'hanijpan.tflite'
    report={'status':'running','sourceSha256':sha(model),'runtime':{'python':sys.version,'tensorflow':tf.__version__,'onnxruntime':ort.__version__},'attempts':[],'samples':[],'limits':['single-line recognizer only','experimental greedy label collapse; no full native decoding equivalence','no private DLL decompilation or custom kernels']}
    commands=[('tf2onnx',[sys.executable,'-m','tf2onnx.convert','--tflite',str(model),'--opset','17','--output',str(directory/'hanijpan-tf2onnx.onnx')]),
              ('tflite2onnx',[sys.executable,'-c','import sys,tflite2onnx;tflite2onnx.convert(sys.argv[1],sys.argv[2])',str(model),str(directory/'hanijpan-tflite2onnx.onnx')])]
    converted=None
    previous_path=directory/'result.json'
    if previous_path.exists():
        previous=json.loads(previous_path.read_text('utf-8'))
        for attempt in previous.get('attempts',[]):
            candidate=directory/f'hanijpan-{attempt["tool"]}.onnx'
            if previous.get('sourceSha256')==report['sourceSha256'] and attempt.get('sha256') and candidate.exists() and sha(candidate)==attempt['sha256']:
                options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
                session=ort.InferenceSession(str(candidate),sess_options=options,providers=['CPUExecutionProvider']);converted=candidate
                report['attempts']=previous['attempts'];report['reusedVerifiedConversion']=True;break
    for tool,command in ([] if converted else commands):
        print('Conversion attempt:',tool,flush=True);start=time.perf_counter()
        with (directory/f'{tool}.log').open('w',encoding='utf-8') as log:
            process=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
        candidate=directory/f'hanijpan-{tool}.onnx'
        attempt={'tool':tool,'command':command,'returncode':process.returncode,'seconds':time.perf_counter()-start,'log':f'portable/{tool}.log'}
        if process.returncode==0 and candidate.exists():
            try:
                options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
                session=ort.InferenceSession(str(candidate),sess_options=options,providers=['CPUExecutionProvider'])
                attempt.update(status='converted-and-native-ORT-loadable',sha256=sha(candidate),bytes=candidate.stat().st_size)
                converted=candidate
            except Exception as error:attempt.update(status='converted-but-ORT-load-failed',error=repr(error))
        else:attempt['status']='conversion-failed'
        report['attempts'].append(attempt);save('portable/result.json',report)
        if converted:break
    interpreter=tf.lite.Interpreter(model_path=str(model),num_threads=1);interpreter.allocate_tensors()
    inputs=interpreter.get_input_details();outputs=interpreter.get_output_details()
    report['input']={'name':inputs[0]['name'],'shape':inputs[0]['shape'].tolist(),'dtype':str(inputs[0]['dtype']),'quantization':list(inputs[0]['quantization'])}
    report['outputs']=[{'name':r['name'],'shape':r['shape'].tolist(),'dtype':str(r['dtype']),'quantization':list(r['quantization'])} for r in outputs]
    spec=importlib.util.spec_from_file_location('locro_wire',OUT/'external/clv-locro/locro/_protobuf.py');wire=importlib.util.module_from_spec(spec);spec.loader.exec_module(wire)
    labels={};blank=None
    for fn,wt,val in wire._decode_raw((source/'hanijpan_label_map.pb').read_bytes()):
        if fn==2 and wt==0:blank=val
        if wt!=2:continue
        text='';index=0
        for n,w,v in wire._decode_raw(val):
            if n==1 and w==2:text=v.decode('utf-8','replace')
            if n==2 and w==0:index=v
        labels[index]=text
    if blank is None:raise ValueError('Explicit CTC blank id missing from label map')
    report['labelMap']={'labels':len(labels),'blankId':blank,'classes':max(max(labels),blank)+1,'sha256':sha(source/'hanijpan_label_map.pb')}
    save('portable/labels.json',labels)
    save('portable/result.json',report)
    font=ImageFont.truetype(str(ROOT/'public/fonts/NotoSansCJKtc-Regular.otf'),24)
    phrases=['今日は晴れ','ありがとう','何を作った','肉じゃが']
    cases=[(text,fit) for fit in [False,True] for text in phrases]
    for index,(text,fit) in enumerate(cases):
        image=Image.new('L',(168,32),255);draw=ImageDraw.Draw(image);draw.text((4,-1),text,font=font,fill=0)
        if fit:
            bounds=ImageOps.invert(image).getbbox()
            image=image.crop(bounds).resize((168,32),Image.Resampling.BILINEAR)
        filename=f'line-{index}.png';image.save(directory/filename)
        tensor=np.asarray(image,dtype=np.uint8)[None,:,:,None].copy();tensor.tofile(directory/f'line-{index}.u8')
        interpreter.set_tensor(inputs[0]['index'],tensor);start=time.perf_counter();interpreter.invoke();native_ms=(time.perf_counter()-start)*1000
        values=[interpreter.get_tensor(r['index']) for r in outputs]
        score_index=next(i for i,v in enumerate(values) if v.ndim==3 and v.shape[-1]==report['labelMap']['classes'])
        scores=values[score_index][0];ids=np.argmax(scores,axis=-1).tolist()
        # Standard CTC collapse with the blank id explicitly declared in the label map.
        collapsed=[token for j,token in enumerate(ids) if j==0 or token!=ids[j-1]]
        decoded=''.join(labels.get(token,'?') for token in collapsed if token!=blank).strip()
        row={'id':f'portable-{index}','reference':text,'preprocessing':'tight black-ink bounds stretched to 168x32' if fit else 'fixed font24 on 168x32 white canvas', 'image':f'portable/{filename}','tensor':f'portable/line-{index}.u8','source':decoded,'greedyIds':ids,'experimentalDecoder':True,'tfliteMs':native_ms,'scoreOutputName':outputs[score_index]['name']}
        np.savez_compressed(directory/f'line-{index}-tflite.npz',**{r['name']:v for r,v in zip(outputs,values)})
        if converted:
            start=time.perf_counter();actual=session.run(None,{session.get_inputs()[0].name:tensor});row['onnxMs']=(time.perf_counter()-start)*1000
            comparisons=[]
            for out,arr in zip(session.get_outputs(),actual):
                oi=next((j for j,r in enumerate(outputs) if r['name']==out.name),None)
                if oi is None:raise ValueError('Output name mapping missing: '+out.name)
                expected=values[oi];delta=np.abs(arr.astype(np.float64)-expected.astype(np.float64))
                comparisons.append({'name':out.name,'shape':list(arr.shape),'dtype':str(arr.dtype),'maxAbsoluteDifference':float(delta.max()),'meanAbsoluteDifference':float(delta.mean()),'exact':bool(np.array_equal(arr,expected))})
            score_output=next(v for r,v in zip(session.get_outputs(),actual) if r.name==row['scoreOutputName'])
            row['onnxGreedyIds']=np.argmax(score_output[0],axis=-1).tolist();row['argmaxParity']=row['onnxGreedyIds']==ids;row['tensorParity']=comparisons
            onnx_ids=row['onnxGreedyIds'];onnx_collapsed=[token for j,token in enumerate(onnx_ids) if j==0 or token!=onnx_ids[j-1]]
            row['onnxSource']=''.join(labels.get(token,'?') for token in onnx_collapsed if token!=blank).strip()
        report['samples'].append(row);save('portable/result.json',report)
        print('single-line probe',index,'greedy=',repr(decoded),flush=True)
    report['onnxModel']=str(converted.relative_to(OUT)).replace('\\','/') if converted else None
    report['status']='native-probe-complete' if converted else 'conversion-blocked-tflite-probe-complete'
    report['fullScreenAIParity']=False;save('portable/result.json',report)

if __name__=='__main__':
    try:main()
    except Exception as error:
        path=OUT/'portable/result.json';report=json.loads(path.read_text('utf-8')) if path.exists() else {}
        report.update(status='failed',error=repr(error));save('portable/result.json',report);raise
