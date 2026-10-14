"""Actual licensed comic inference; all OCR is candidate text until reviewed."""
import pathlib,json,sys,time,argparse,hashlib
from PIL import Image
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'))
from vision import Vision

def reading_order(regions):
    rows=[]
    for region in sorted(regions,key=lambda r:r['y']):
        row=next((row for row in rows if abs(row[0]['y']-region['y'])<min(row[0]['height'],region['height'])*.45),None)
        if row is None:rows.append([region])
        else:row.append(region)
    return [r for row in rows for r in sorted(row,key=lambda r:-r['x'])]

parser=argparse.ArgumentParser();parser.add_argument('--pages',type=int,default=40);parser.add_argument('--resume',action='store_true');args=parser.parse_args()
directory=ROOT/'artifacts/real-corpus';manifest=json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
vision=Vision();result={'schema':1,'sourceManifestSha256':hashlib.file_digest((directory/'manifest.json').open('rb'),'sha256').hexdigest(),'credit':manifest['credit'],'source':manifest['source'],'backend':'ONNX CPU, 4 threads','pipelineRevision':'eight-neighbor','scope':'actual model execution on author-published manga; candidate OCR only','independentGroundTruth':False,'humanReview':'pending','pages':[]}
previous={}
if args.resume and (directory/'inference.json').exists():
    prior=json.loads((directory/'inference.json').read_text(encoding='utf-8'))
    if prior.get('pipelineRevision')=='eight-neighbor':previous={p['file']:p for p in prior['pages']}
for page in manifest['pages'][:args.pages]:
    cached=previous.get(page['file'])
    if cached and cached.get('sha256')==page['sha256']:
        result['pages'].append(cached);print(f"PDF page {page['pdfPage']}: reused identical image/pipeline result",flush=True);continue
    started=time.perf_counter();image=Image.open(directory/page['file']);regions=reading_order(vision.detect(image));output=[]
    for index,region in enumerate(regions):
        text,warnings=vision.ocr(image,region)
        output.append({**region,'id':f"real-p{page['pdfPage']:03}-r{index+1:02}",'order':index,'source':text,'translation':'','warnings':warnings,'render':'auto' if region['kind']=='bubble' else 'overlay','review':{'status':'unreviewed','referenceSource':'','referenceTranslation':'','meaning':None,'address':None,'tone':None,'traditional':None}})
    result['pages'].append({**page,'regions':output,'ms':(time.perf_counter()-started)*1000})
    (directory/'inference.partial.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f"PDF page {page['pdfPage']}: regions={len(output)}, recognized={sum(bool(r['source']) for r in output)}, {(time.perf_counter()-started):.2f}s",flush=True)
result['metrics']={'pages':len(result['pages']),'detectedRegions':sum(len(p['regions']) for p in result['pages']),'nonemptyOCR':sum(bool(r['source']) for p in result['pages'] for r in p['regions']),'warningRegions':sum(bool(r['warnings']) for p in result['pages'] for r in p['regions']),'recall':None,'cer':None,'humanTranslationAcceptance':None}
result['status']='executed-pending-independent-annotation'
(directory/'inference.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result['metrics'],ensure_ascii=False),flush=True)
