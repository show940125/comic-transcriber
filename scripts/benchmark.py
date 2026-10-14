import json, pathlib, sys, time, statistics, unicodedata, argparse
from PIL import Image
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from vision import Vision

def normalize(text):
    return ''.join(unicodedata.normalize('NFKC',text).split())

def distance(a,b):
    row=list(range(len(b)+1))
    for i,x in enumerate(a):
        nextrow=[i+1]
        for j,y in enumerate(b): nextrow.append(min(nextrow[-1]+1,row[j+1]+1,row[j]+(x!=y)))
        row=nextrow
    return row[-1]

def iou(a,b):
    area=max(0,min(a['x']+a['width'],b['x']+b['width'])-max(a['x'],b['x']))*max(0,min(a['y']+a['height'],b['y']+b['height'])-max(a['y'],b['y']))
    return area/(a['width']*a['height']+b['width']*b['height']-area or 1)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--pages',type=int,default=30);args=parser.parse_args()
    manifest=json.loads((ROOT/'artifacts/corpus/manifest.json').read_text(encoding='utf-8'))
    vision=Vision(); result={'kind':'native-onnx-cpu synthetic ground-truth-crop OCR','real_manga_acceptance':False,'human_translation_review':'pending','pages':[]}
    edits=chars=hits=count=e2e_edits=0; times=[]
    for page in manifest['pages'][:args.pages]:
        started=time.perf_counter();image=Image.open(ROOT/'artifacts/corpus'/page['file']);detections=vision.detect(image)
        page_result={'file':page['file'],'category':page['category'],'detections':detections,'regions':[]}
        for r in page['regions']:
            began=time.perf_counter();text,warnings=vision.ocr(image,r);elapsed=time.perf_counter()-began
            truth=normalize(r['source']); error=distance(truth,normalize(text));edits+=error;chars+=len(truth);count+=1
            detected=max(detections,key=lambda d:iou(r,d),default=None)
            best=iou(r,detected) if detected else 0;hits+=best>=.5
            detected_text,_=vision.ocr(image,detected) if detected and best>0 else ('',[])
            e2e_error=distance(truth,normalize(detected_text));e2e_edits+=e2e_error
            page_result['regions'].append({'id':r['id'],'source':r['source'],'ocr':text,'detected_crop_ocr':detected_text,'edits':error,'detected_crop_edits':e2e_error,'characters':len(truth),'best_iou':best,'ms':elapsed*1000,'warnings':warnings})
        blank,_=vision.ocr(image,page['blank']);page_result['blank_ocr']=blank
        elapsed=time.perf_counter()-started;times.append(elapsed);page_result['seconds']=elapsed;result['pages'].append(page_result)
        (ROOT/'artifacts/native-benchmark.partial.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(f"{page['file']}: {elapsed:.2f}s, regions={len(detections)}, cumulative CER={edits/chars:.3%}",flush=True)
    result['metrics']={'regions':count,'cer':edits/chars,'detected_crop_cer':e2e_edits/chars,'recall_iou_05':hits/count,'blank_hallucinations':sum(bool(p['blank_ocr']) for p in result['pages']),'page_p50_s':statistics.median(times),'page_p95_s':sorted(times)[min(len(times)-1,int(len(times)*.95))]}
    (ROOT/'artifacts/native-benchmark.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result['metrics'],ensure_ascii=False),flush=True)
