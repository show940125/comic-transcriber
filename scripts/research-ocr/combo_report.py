"""Freeze adoption decisions using full Canvas accuracy plus isolated fixed-sample trials."""
import json,statistics
from prepare import OUT,ROOT,save,sha
from metrics import evaluate,parity
data=json.loads((OUT/'dataset.json').read_text());refs=json.loads((OUT/'references.json').read_text());results={};metrics={};trials={}
for variant in ['baseline','int8','kv','hybrid','qint8']:
    name=f'web-{variant}-t4-canvas';full=json.loads((OUT/f'results/{name}.json').read_text());sample=json.loads((OUT/f'results/web-{variant}-t4-sample-canvas.json').read_text());receipt=json.loads((OUT/f'results/web-{variant}-t4-sample-canvas-receipt.json').read_text())
    assert full['status']==sample['status']==receipt['status']=='complete'
    assert len(full['results'])==479 and len(sample['results'])==50 and len(sample['performance'])==3
    assert not receipt['blockedRequests'] and not receipt['consoleErrors']
    assert {r['id'] for r in full['results']}=={r['id'] for r in data['records']}
    assert {r['id'] for r in sample['results']}==set(data['sample'])
    for run in sample['performance']:assert {r['id'] for r in run['rows']}==set(data['sample'])
    assert sample['requestedThreads']==4 and sample['crossOriginIsolated'] and len(sample['spawnedWorkers'])>=3
    metrics[variant]=evaluate(data['records'],full['results'],refs);results[variant]=full['results']
    main=max((r for r in receipt['processMemory']['processes'] if r['type']=='renderer'),key=lambda r:r['cpuTime'])
    trials[variant]={'median50Ms':statistics.median(r['totalMs'] for r in sample['performance']),'rendererPeakWorkingSetBytes':main['peakWorkingSetBytes'],'rendererPid':main['id'],'sampleResultSha256':sha(OUT/f'results/web-{variant}-t4-sample-canvas.json'),'receiptSha256':sha(OUT/f'results/web-{variant}-t4-sample-canvas-receipt.json')}
size=lambda folder:sum(p.stat().st_size for p in folder.glob('*.onnx') if 'prepared' not in p.name)
vocab=(ROOT/'.cache/models/manga-ocr/vocab.txt').stat().st_size;fp32=size(ROOT/'.cache/models/manga-ocr')+vocab;int8=size(OUT/'models/int8')+vocab
gates={'int8SyntheticDelta':metrics['int8']['groups']['synthetic']['cer']-metrics['baseline']['groups']['synthetic']['cer'],'int8SizeReduction':1-int8/fp32,'int8BlankDelta':metrics['int8']['groups']['blank']['blankHallucinations']-metrics['baseline']['groups']['blank']['blankHallucinations']}
gates['int8Adopt']=gates['int8SyntheticDelta']<=.005 and gates['int8SizeReduction']>=.5 and gates['int8BlankDelta']<=0
kv=parity(results['baseline'],results['kv']);gates['fp32KvSpeedGain']=1-trials['kv']['median50Ms']/trials['baseline']['median50Ms'];gates['fp32KvAdopt']=kv['identical'] and gates['fp32KvSpeedGain']>=.15
for variant in ['hybrid','qint8']:
    g={'speedGainVsInt8':1-trials[variant]['median50Ms']/trials['int8']['median50Ms'],'rendererPeakIncreaseVsInt8':trials[variant]['rendererPeakWorkingSetBytes']/trials['int8']['rendererPeakWorkingSetBytes']-1,'syntheticDeltaVsBaseline':metrics[variant]['groups']['synthetic']['cer']-metrics['baseline']['groups']['synthetic']['cer'],'blankErrors':metrics[variant]['groups']['blank']['blankHallucinations']}
    g['adopt']=g['speedGainVsInt8']>=.15 and g['rendererPeakIncreaseVsInt8']<=.25 and g['syntheticDeltaVsBaseline']<=.005 and g['blankErrors']<=metrics['baseline']['groups']['blank']['blankHallucinations'];gates[variant]=g
differences={variant:[{'id':r['id'],'baseline':r['source'],'candidate':next(c['source'] for c in results[variant] if c['id']==r['id'])} for r in results['baseline'] if any(c['id']==r['id'] and c['source']!=r['source'] for c in results[variant])] for variant in ['int8','kv','hybrid','qint8']}
selected=min((v for v in ['hybrid','qint8'] if gates[v]['adopt']),key=lambda v:trials[v]['median50Ms'],default='int8')
save('combo/adoption.json',{'status':'complete','datasetSha256':sha(OUT/'dataset.json'),'humanGold':False,'trials':trials,'metrics':metrics,'gates':gates,'fp32TokenParity':kv,'sourceDifferences':differences,'selectedInt8':selected,'selectedFp32':'kv' if gates['fp32KvAdopt'] else 'baseline','bytes':{'fp32':fp32,'int8':int8},'memoryScope':'largest CPU-time renderer per isolated trial; per-process lifetime peak, not aggregate plugin RAM'})
print(json.dumps({'selectedInt8':selected,'gates':gates,'textDifferenceCounts':{k:len(v) for k,v in differences.items()}},ensure_ascii=False))
