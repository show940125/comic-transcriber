import pathlib,sys,json,time,statistics,argparse
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'))
from native_llm import complete
parser=argparse.ArgumentParser();parser.add_argument('--pages',type=int,default=30);args=parser.parse_args()
corpus=json.loads((ROOT/'artifacts/corpus/manifest.json').read_text(encoding='utf-8'))
report={'type':'actual llama.cpp CPU GGUF, original synthetic dialogues','humanReview':'pending','models':[],'started':time.time()}
for model in ['qwen3.5-0.8b','qwen3.5-2b']:
    entry={'model':model,'pages':[],'failures':[]};report['models'].append(entry)
    for page in corpus['pages'][:args.pages]:
        rows=[{'id':r['id'],'text':r['source']} for r in page['regions']]
        messages=[{'role':'system','content':f'你是日文漫畫的臺灣繁體中文譯者。保留原意、語氣與稱呼，不添加情節。只輸出一個完整JSON陣列，共{len(rows)}筆，每項為id及text。id保持原值，text是自然繁體中文譯文。'},{'role':'user','content':json.dumps({'dialogue':rows},ensure_ascii=False)}]
        try:
            text,ms=complete(messages,model)
            entry['pages'].append({'file':page['file'],'ms':ms,'translations':json.loads(text)})
            print(f'{model}: {page["file"]} {ms/1000:.2f}s',flush=True)
        except Exception as error:
            entry['failures'].append({'file':page['file'],'error':str(error)});print('Failure',model,str(error),flush=True);break
        (ROOT/'artifacts/native-translation-benchmark.partial.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    if entry['pages']:
        times=sorted(p['ms']/1000 for p in entry['pages']);entry['metrics']={'pages':len(times),'p50_s':statistics.median(times),'p95_s':times[min(len(times)-1,int(len(times)*.95))]}
report['status']='executed-pending-human-quality-review' if all(len(m['pages'])==args.pages for m in report['models']) else 'incomplete';report['finished']=time.time()
(ROOT/'artifacts/native-translation-benchmark.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'status':report['status'],'models':[{k:v for k,v in m.items() if k!='pages'} for m in report['models']]},ensure_ascii=False),flush=True)
sys.exit(0 if report['status']!='incomplete' else 1)
