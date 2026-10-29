"""Bounded crop heuristics; diagnostic candidates preserve all original crops."""
import json,statistics
import numpy as np
from PIL import Image,ImageOps
from prepare import OUT,save,sha
from native import Manga
from metrics import evaluate
data=json.loads((OUT/'dataset.json').read_text());refs=json.loads((OUT/'references.json').read_text());engine=Manga('int8',threads=4)
def bands(image,axis):
    values=np.asarray(ImageOps.grayscale(image))<140;counts=values.sum(axis=axis);occupied=counts>=max(2,values.shape[axis]*.02);runs=[];start=None
    for i,on in enumerate([*occupied,False]):
        if on and start is None:start=i
        if not on and start is not None:
            if i-start>=2:runs.append((start,i))
            start=None
    # Merge narrow gaps between strokes of the same column/line.
    merged=[]
    for a,b in runs:
        if merged and a-merged[-1][1]<max(3,min(image.size)*.035):merged[-1]=(merged[-1][0],b)
        else:merged.append((a,b))
    return merged
result={'status':'running','backend':'native INT8 CPU, intra=4','preprocessing':'Pillow grayscale/BILINEAR diagnostic; production Canvas acceptance separate','variants':{},'originalsRetained':True,'humanGold':False}
for variant in ['control','padding','split-lines','furigana-body']:
    outputs=[];operations=[]
    for row in data['records']:
        image=Image.open(OUT/row['crop']).convert('RGB');parts=[image]
        if variant=='padding':parts=[ImageOps.expand(image,border=max(2,round(min(image.size)*.05)),fill='white')]
        elif variant in ['split-lines','furigana-body']:
            vertical=image.height>image.width*1.3;horizontal=image.width>image.height*1.3
            runs=bands(image,0 if vertical else 1) if vertical or horizontal else []
            if 2<=len(runs)<=6:
                widths=[b-a for a,b in runs];median=statistics.median(widths)
                if variant=='furigana-body' and vertical:
                    retained=[(a,b) for a,b in runs if b-a>=median*.6];removed=[(a,b) for a,b in runs if b-a<median*.6]
                    if retained and removed:
                        parts=[image.crop((min(a for a,b in retained),0,max(b for a,b in retained),image.height))];operations.append({'id':row['id'],'annotationBands':removed,'policy':'candidate body crop; original still retained'})
                elif variant=='split-lines':
                    ordered=list(reversed(runs)) if vertical else runs
                    parts=[image.crop((a,0,b,image.height) if vertical else (0,a,image.width,b)) for a,b in ordered];operations.append({'id':row['id'],'axis':'vertical' if vertical else 'horizontal','bands':ordered})
        candidates=[]
        for index,part in enumerate(parts):
            if variant=='control':candidate=engine.infer(row)
            else:
                name=f'combo/preprocess/{variant}-{row["id"]}-{index}';base=OUT/name;base.parent.mkdir(parents=True,exist_ok=True);part.save(base.with_suffix('.png'))
                gray=ImageOps.grayscale(part).resize((224,224),Image.Resampling.BILINEAR);plane=(np.asarray(gray,dtype=np.float32)/255-.5)*2;np.stack([plane]*3)[None].astype('<f4').tofile(base.with_suffix('.f32'))
                candidate=engine.infer({**row,'tensor':name+'.f32','skipBlank':bool(np.count_nonzero(plane<-.2157)<24 or np.count_nonzero(plane>.2157)<24)})
            candidates.append(candidate)
        outputs.append({'id':row['id'],'source':''.join(r['source'] for r in candidates),'parts':candidates,'ms':sum(r['ms'] for r in candidates),'truncated':any(r.get('truncated',False) for r in candidates)})
    result['variants'][variant]={'results':outputs,'operations':operations,'metrics':evaluate(data['records'],outputs,refs)};save('combo/preprocess.json',result);print(variant,'complete',flush=True)
result['status']='complete';result['decision']='keep experimental; individual crop gains and regressions need review before any production preprocessing change';save('combo/preprocess.json',result)
