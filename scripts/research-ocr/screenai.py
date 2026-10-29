"""Use the pinned, unmodified MIT clv-locro bridge in an isolated foreground child."""
import argparse, json, logging, sys, time
from pathlib import Path
from PIL import Image
from prepare import OUT,save,sha
from process_memory import own_memory as peak_memory

sys.path.insert(0,str(OUT/'external/clv-locro'))
# DEBUG preserves stderr instead of the wrapper permanently suppressing it.
logging.basicConfig(level=logging.DEBUG)
from locro._dll import ScreenAIDll
from locro._protobuf import parse_visual_annotation,_decode_raw,_parse_rect

def structured(raw):
    parsed=parse_visual_annotation(raw);rows=[]
    raw_lines=[val for fn,wt,val in _decode_raw(raw) if fn==2 and wt==2]
    for line,wire in zip(parsed,raw_lines):
        r={key:getattr(line,key) for key in line.__slots__ if key!='words'}
        r['words']=[]
        wire_words=[val for fn,wt,val in _decode_raw(wire) if fn==1 and wt==2]
        for word,ww in zip(line.words,wire_words):
            w={key:getattr(word,key) for key in word.__slots__};w['symbols']=[]
            for fn,wt,val in _decode_raw(ww):
                if fn!=1 or wt!=2:continue
                symbol={}
                for sn,sw,sv in _decode_raw(val):
                    if sn==1 and sw==2:symbol['box']=_parse_rect(sv)
                    elif sn==2 and sw==2:symbol['text']=sv.decode('utf-8','replace')
                    elif sn==3 and sw==5:symbol['confidence']=sv
                w['symbols'].append(symbol)
            r['words'].append(w)
        rows.append(r)
    return rows

def main():
    p=argparse.ArgumentParser();p.add_argument('--mode',choices=['smoke','all','portable'],default='smoke');args=p.parse_args()
    screen=Path.home()/'AppData/Local/Google/Chrome/User Data/screen_ai/153.4'
    data=json.loads((OUT/'dataset.json').read_text('utf-8'))
    result={'status':'initializing','backend':'Chrome Screen AI native DLL through pinned clv-locro','mode':args.mode,'datasetSha256':sha(OUT/'dataset.json'),'results':[],'performance':[],'pages':[],'threading':'engine-managed; not forced equivalent to ORT intra=1'}
    filename=f'results/screenai-{args.mode}.json';save(filename,result)
    started=time.perf_counter();dll=ScreenAIDll(screen);result['version']=dll.get_version()
    if not dll.init_ocr():raise RuntimeError('Screen AI init returned false')
    dll.set_light_mode(False);limit=dll.get_max_image_dimension();result.update(initMs=(time.perf_counter()-started)*1000,maxDimension=limit,status='running')
    rawdir=OUT/'screenai-protobuf';rawdir.mkdir(exist_ok=True)
    def infer(row,retain=True):
        begin=time.perf_counter();im=Image.open(OUT/row['crop']).convert('RGBA');original=im.size
        if max(im.size)>limit:im.thumbnail((limit,limit),Image.Resampling.LANCZOS)
        raw=dll.perform_ocr(im.tobytes('raw','BGRA'),*im.size)
        if raw is None:raise RuntimeError('PerformOCR returned NULL for '+row['id'])
        lines=structured(raw)
        if retain:(rawdir/f'{row["id"]}.pb').write_bytes(raw)
        return {'id':row['id'],'source':'\n'.join(r['text'] for r in lines),'lines':lines,'originalSize':original,'ocrSize':im.size,'rawBytes':len(raw),'ms':(time.perf_counter()-begin)*1000,'ended':True}
    if args.mode=='portable':
        probe=json.loads((OUT/'portable/result.json').read_text('utf-8'))
        rows=[{'id':s['id'],'crop':s['image']} for s in probe['samples']]
    else:rows=data['records'] if args.mode=='all' else [next(r for r in data['records'] if r['id']==data['sample'][0])]*3
    try:
        for i,row in enumerate(rows):
            result['results'].append(infer(row))
            if i%20==0 or i==len(rows)-1:result['memory']=peak_memory();save(filename,result);print(f'screenai {i+1}/{len(rows)}',flush=True)
        if args.mode=='all':
            sample=[next(r for r in rows if r['id']==rid) for rid in data['sample']]
            for run in range(3):
                output=[infer(r,False) for r in sample];result['performance'].append({'run':run+1,'warm':True,'totalMs':sum(r['ms'] for r in output),'rows':[{k:r[k] for k in ['id','source','ms']} for r in output]});save(filename,result)
            for page in data['pages']:
                row={'id':f'page-{page["page"]:02}','crop':page['file']};result['pages'].append(infer(row));save(filename,result)
        result.update(status='complete',memory=peak_memory(),totalSeconds=time.perf_counter()-started);save(filename,result)
    except Exception as error:result.update(status='failed',error=repr(error),memory=peak_memory());save(filename,result);raise

if __name__=='__main__':main()
