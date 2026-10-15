"""Reproducible native comparison; shares fixed float32 inputs with browser."""
import sys,json,time,hashlib,gc
from pathlib import Path
import numpy as np
import onnxruntime as ort
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'backend'))
from vision import Vision
from PIL import Image
out=root/'artifacts/regression-0.1.10'
out.mkdir(parents=True,exist_ok=True)
directory=out/'tensors';directory.mkdir(exist_ok=True)
source=json.loads((root/'artifacts/regression-0.1.9/visual.json').read_text('utf-8'))
files=[]
for item in source['results']:
    region=next(r for r in item['regions'] if r['source'].strip() and not r.get('needsReview'))
    with Image.open(root/'artifacts/regression-0.1.9/chapter-21'/item['file']) as image:
        tensor=Vision.crop_tensor(image,region)
    name=item['file']+'.f32';(directory/name).write_bytes(tensor.astype('<f4').tobytes());files.append(name)
(out/'tensor-index.json').write_text(json.dumps(files),'utf-8')
if '--prepare-only' in sys.argv:
    print(json.dumps({'prepared':files}));raise SystemExit
results=[]
for threads in [1,2,4]:
    vision=Vision(threads);start=time.perf_counter();vision.init_ocr();init_ms=(time.perf_counter()-start)*1000;runs=[]
    for run in range(4):
        timings=[];outputs=[]
        for name in files:
            tensor=np.fromfile(directory/name,dtype='<f4').reshape(1,3,224,224);start=time.perf_counter()
            encoded=vision.encoder.run(None,{vision.encoder.get_inputs()[0].name:tensor})[0];tokens=[2]
            for _ in range(64):
                feeds={i.name:encoded if ('encoder' in i.name or 'hidden' in i.name) else np.array([tokens],dtype=np.int64) for i in vision.decoder.get_inputs()}
                logits=vision.decoder.run(None,feeds)[0];token=int(np.argmax(logits[0,-1]))
                if token==3:break
                tokens.append(token)
            timings.append((time.perf_counter()-start)*1000);outputs.append(tokens)
        runs.append({'run':run,'cold':run==0,'timings':timings,'tokens':outputs})
    results.append({'threads':threads,'initMs':init_ms,'results':runs});del vision;gc.collect()
    (out/'native-threads.json').write_text(json.dumps({'runtime':ort.__version__,'results':results,'inputs':[{'file':f,'sha256':hashlib.sha256((directory/f).read_bytes()).hexdigest()} for f in files]},indent=2),'utf-8')
    print(json.dumps({'threads':threads,'warmMs':[sum(r['timings']) for r in runs[1:]]}),flush=True)
