"""Foreground controller records child exit status, including native access violations."""
import json,subprocess,sys,time
from prepare import OUT,ROOT,save,sha

for mode in ['smoke','all']:
    command=[sys.executable,str(ROOT/'scripts/research-ocr/screenai.py'),'--mode',mode]
    log=OUT/f'results/screenai-{mode}.log';started=time.perf_counter()
    print('Screen AI child starting:',mode,flush=True)
    with log.open('w',encoding='utf-8') as output:
        result=subprocess.run(command,stdout=output,stderr=subprocess.STDOUT)
    path=OUT/f'results/screenai-{mode}.json'
    content=json.loads(path.read_text('utf-8')) if path.exists() else {}
    receipt={'mode':mode,'command':command,'returncode':result.returncode,'seconds':time.perf_counter()-started,
             'childStatus':content.get('status'),'scriptSha256':sha(ROOT/'scripts/research-ocr/screenai.py'),'log':str(log.relative_to(OUT)),
             'status':'complete' if result.returncode==0 and content.get('status')=='complete' else 'failed',
             'fallbackRequired':result.returncode!=0 or content.get('status')!='complete'}
    save(f'results/screenai-{mode}-receipt.json',receipt);print(json.dumps(receipt),flush=True)
    if receipt['status']!='complete':break
