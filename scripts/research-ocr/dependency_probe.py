"""Trace public file callbacks; test one language-model restriction in a child."""
import argparse,json,subprocess,sys
from pathlib import Path
from PIL import Image
from prepare import OUT,save
p=argparse.ArgumentParser();p.add_argument('--child',action='store_true');p.add_argument('--restricted',action='store_true');args=p.parse_args()
if args.child:
    from screenai import ScreenAIDll
    import locro._dll as bridge
    requests=[];original=bridge._read_model_file;phase='init'
    def traced(name):
        normalized=name.replace('\\','/');deny=args.restricted and '/line_recognition_mobile_convnext320_omni/' in '/'+normalized and 'hanijpan' not in normalized
        requests.append({'path':normalized,'phase':phase,'denied':deny});return b'' if deny else original(name)
    bridge._read_model_file=traced;dll=ScreenAIDll(Path.home()/'AppData/Local/Google/Chrome/User Data/screen_ai/153.4');ok=dll.init_ocr();phase='ocr';result={'initialized':ok,'requests':requests,'restricted':args.restricted}
    if ok:
        row=json.loads((OUT/'dataset.json').read_text())['records'][20];image=Image.open(OUT/row['crop']).convert('RGBA');raw=dll.perform_ocr(image.tobytes('raw','BGRA'),*image.size);result['rawBytes']=None if raw is None else len(raw)
    save('combo/dependency-'+('restricted' if args.restricted else 'full')+'.json',result)
else:
    result={'status':'complete','attempts':[],'boundary':'no DLL decompilation; observed file callback access is not a general minimal dependency proof'}
    for restricted in [False,True]:
        name='restricted' if restricted else 'full';child=subprocess.run([sys.executable,__file__,'--child']+(['--restricted'] if restricted else []),capture_output=True);(OUT/f'combo/dependency-{name}.log').write_bytes(child.stdout+child.stderr);result['attempts'].append({'name':name,'exitCode':child.returncode})
    save('combo/dependency-probe.json',result);print(json.dumps(result))
