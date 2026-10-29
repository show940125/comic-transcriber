"""Owned finite worker test: reuse, idle exit, EOF exit and injected failure."""
import argparse,json,os,queue,subprocess,sys,threading,time
from pathlib import Path
from PIL import Image
from prepare import OUT,save
p=argparse.ArgumentParser();p.add_argument('--child',action='store_true');p.add_argument('--fail',action='store_true');args=p.parse_args()
if args.child:
    from screenai import ScreenAIDll,structured
    dll=ScreenAIDll(Path.home()/'AppData/Local/Google/Chrome/User Data/screen_ai/153.4')
    if not dll.init_ocr():raise RuntimeError('initialization failed')
    q=queue.Queue()
    def reader():
        for line in sys.stdin:q.put(line)
        q.put(None)
    threading.Thread(target=reader,daemon=True).start();print(json.dumps({'ready':True,'pid':os.getpid(),'version':dll.get_version()}),flush=True)
    while True:
        try:line=q.get(timeout=1.0)
        except queue.Empty:print(json.dumps({'idleReleased':True}),flush=True);break
        if line is None:break
        try:
            request=json.loads(line)
            if args.fail:raise RuntimeError('injected worker failure')
            image=Image.open(OUT/request['crop']).convert('RGBA');raw=dll.perform_ocr(image.tobytes('raw','BGRA'),*image.size)
            if raw is None:raise RuntimeError('PerformOCR returned NULL')
            print(json.dumps({'ok':True,'id':request['id'],'pid':os.getpid(),'source':'\n'.join(r['text'] for r in structured(raw))},ensure_ascii=False),flush=True)
        except Exception as error:print(json.dumps({'ok':False,'error':repr(error)},ensure_ascii=False),flush=True);sys.exit(1)
else:
    row=json.loads((OUT/'dataset.json').read_text())['records'][20];result={'status':'running','tests':[],'idleTestSeconds':1,'productionIdleProposedSeconds':60}
    for scenario in ['reuse-idle','eof','injected-failure']:
        log=(OUT/f'combo/lifecycle-{scenario}.log').open('w',encoding='utf-8')
        child=subprocess.Popen([sys.executable,__file__,'--child']+(['--fail'] if scenario=='injected-failure' else []),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf-8')
        receipt={'scenario':scenario,'pid':child.pid,'ready':json.loads(child.stdout.readline()),'calls':[]}
        for _ in range(3 if scenario=='reuse-idle' else 1):
            child.stdin.write(json.dumps(row)+'\n');child.stdin.flush();receipt['calls'].append(json.loads(child.stdout.readline()))
        if scenario!='reuse-idle':child.stdin.close()
        receipt['exitCode']=child.wait(timeout=15);receipt['tail']=child.stdout.read();log.close()
        assert receipt['exitCode']==(1 if scenario=='injected-failure' else 0)
        if scenario=='injected-failure':assert receipt['calls'][0]['ok'] is False and 'source' not in receipt['calls'][0]
        else:assert all(c['ok'] and c['pid']==child.pid for c in receipt['calls'])
        if scenario=='reuse-idle':assert json.loads(receipt['tail'])['idleReleased']
        result['tests'].append(receipt)
    result['status']='passed';save('combo/bridge-lifecycle.json',result);print('Native lifecycle controls passed; injected error is distinct from empty OCR.')
