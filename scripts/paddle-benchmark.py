"""General PP-OCRv5 Chinese/Japanese comparator with independent projection line splitting."""
import json, pathlib, urllib.request, hashlib, sys, time, math
import numpy as np
import onnxruntime as ort
from PIL import Image
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from benchmark import normalize,distance
revision='7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65'
directory=ROOT/'.cache/models/paddle';directory.mkdir(parents=True,exist_ok=True)
metadata=json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/monkt/paddleocr-onnx/tree/{revision}/languages/chinese'))
lock=[]
for filename in ['rec.onnx','dict.txt']:
    meta=next(m for m in metadata if m['path']==f'languages/chinese/{filename}')
    expected=meta.get('lfs',{}).get('oid');dest=directory/filename
    url=f'https://huggingface.co/monkt/paddleocr-onnx/resolve/{revision}/languages/chinese/{filename}'
    if not dest.exists():
        print('Downloading Paddle',filename,meta['size'],flush=True)
        with urllib.request.urlopen(url,timeout=120) as response,dest.with_suffix('.partial').open('wb') as output:
            while data:=response.read(1024*1024):output.write(data)
        dest.with_suffix('.partial').replace(dest)
    digest=hashlib.file_digest(dest.open('rb'),'sha256').hexdigest()
    if expected and digest!=expected:raise RuntimeError('Paddle model hash mismatch')
    lock.append({'file':filename,'sha256':digest,'url':url,'license':'apache-2.0'})
(ROOT/'artifacts/paddle-lock.json').write_text(json.dumps({'revision':revision,'files':lock},indent=2),encoding='utf-8')
options=ort.SessionOptions();options.intra_op_num_threads=4
session=ort.InferenceSession(str(directory/'rec.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
input_name=session.get_inputs()[0].name
print('Paddle input:',session.get_inputs()[0].shape,flush=True)
vocab=['']+(directory/'dict.txt').read_text(encoding='utf-8').splitlines()+[' ']

def spans(profile):
    out=[];start=None
    for i,v in enumerate(list(profile)+[False]):
        if v and start is None:start=i
        elif not v and start is not None:
            if i-start>=2:out.append((start,i))
            start=None
    return out

def lines(crop,category):
    rgb=np.asarray(crop.convert('RGB'));gray=rgb[:,:,0]*.299+rgb[:,:,1]*.587+rgb[:,:,2]*.114
    mask=gray>170 if np.median(gray)<128 else gray<110
    if category in ['vertical','furigana']:
        output=[]
        columns=[s for s in spans(mask.sum(axis=0)>1) if s[1]-s[0]>=12]
        for x0,x1 in reversed(columns):
            ys=spans(mask[:,x0:x1].sum(axis=1)>1)
            sheet=Image.new('RGB',(max(1,len(ys))*32,32),'white')
            for i,(y0,y1) in enumerate(ys):sheet.paste(crop.crop((x0,y0,x1,y1)).resize((28,28)),(i*32+2,2))
            if ys:output.append(sheet)
        return output
    rows=spans(mask.sum(axis=1)>2)
    return [crop.crop((0,max(0,y0-2),crop.width,min(crop.height,y1+2))) for y0,y1 in rows]

def recognize(crop):
    height=session.get_inputs()[0].shape[2]
    height=height if isinstance(height,int) else 48
    width=min(2048,max(height,int(math.ceil(crop.width/crop.height*height))))
    array=np.asarray(crop.convert('RGB').resize((width,height)),dtype=np.float32)/127.5-1
    output=session.run(None,{input_name:array.transpose((2,0,1))[None]})[0]
    indices=np.argmax(output[0],axis=-1);result=[];last=-1
    for token in indices:
        if token!=0 and token!=last and token<len(vocab):result.append(vocab[token])
        last=token
    return ''.join(result)

manifest=json.loads((ROOT/'artifacts/corpus/manifest.json').read_text(encoding='utf-8'))
result={'kind':'PP-OCRv5 projection-line comparator','modelRevision':revision,'realMangaAcceptance':False,'regions':[]};edits=chars=0
started=time.perf_counter()
for page in manifest['pages']:
    image=Image.open(ROOT/'artifacts/corpus'/page['file'])
    for r in page['regions']:
        crop=image.crop((r['x'],r['y'],r['x']+r['width'],r['y']+r['height']))
        text=''.join(recognize(line) for line in lines(crop,page['category']))
        truth=normalize(r['source']);error=distance(truth,normalize(text));edits+=error;chars+=len(truth)
        result['regions'].append({'id':r['id'],'category':page['category'],'source':r['source'],'ocr':text,'edits':error,'characters':len(truth)})
    print('Paddle',page['file'],f'CER={edits/chars:.2%}',flush=True)
result['metrics']={'regions':len(result['regions']),'cer':edits/chars,'totalSeconds':time.perf_counter()-started}
(ROOT/'artifacts/paddle-benchmark.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result['metrics']),flush=True)
