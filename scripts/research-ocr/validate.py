"""Completion evidence: validate artifacts, never rerun inference."""
from pathlib import Path
import datetime,json
from prepare import OUT,ROOT,sha,save

def read(name):return json.loads((OUT/name).read_text('utf-8'))
data=read('dataset.json');refs=read('references.json');freeze=read('freeze-receipt.json');lock=read('asset-lock.json')
assert sha(OUT/'dataset.json')==freeze['datasetSha256']
assert sha(OUT/'references.json')==freeze['referencesSha256']
assert refs['humanGold'] is False and refs['status']=='frozen-before-inference'
assert sha(data['zip'])==data['zipSha256']
ids={r['id'] for r in data['records']};assert len(ids)==len(data['records'])==479
for row in data['records']:
    assert sha(OUT/row['crop'])==row['cropSha256'],row['id']
    assert sha(OUT/row['tensor'])==row['tensorSha256'],row['id']
    assert (OUT/row['tensor']).stat().st_size==3*224*224*4
for page in data['pages']:assert sha(OUT/page['file'])==page['sha256']
for source in lock['sources']:
    if source.get('sha256'):assert sha(ROOT/source['path'])==source['sha256']
    if source['kind']=='external-source':
        for name,digest in source['files'].items():assert sha(ROOT/source['path']/name)==digest
complete=['web-baseline','web-int8','native-baseline-all','native-int8-all','native-kv-all','web-kv-t4','screenai-all']
for name in complete:
    run=read(f'results/{name}.json');assert run['status']=='complete',name
    assert {r['id'] for r in run['results']}==ids,name
    assert len(run['results'])==len(ids) and len(run['performance'])==3,name
    for r in run['results']:assert isinstance(r['source'],str)
    for perf in run['performance']:assert {r['id'] for r in perf['rows']}==set(data['sample'])
for name in ['web-baseline','web-int8','web-baseline-t4-sample','web-int8-t4-sample','web-kv-t4','web-portable']:
    receipt=read(f'results/{name}-receipt.json');assert receipt['status']=='complete',name
    assert not receipt['blockedRequests'] and not receipt['consoleErrors'],name
    if receipt.get('bundleSha256'):assert sha(OUT/f'web-client-{receipt["bundleSha256"]}.js')==receipt['bundleSha256']
for name in ['web-baseline-t4-sample','web-int8-t4-sample','web-kv-t4']:
    run=read(f'results/{name}.json');assert run['requestedThreads']==4 and run['crossOriginIsolated']
    assert len(run['spawnedWorkers'])>=3,name
    if 'sample' in name:assert {r['id'] for r in run['results']}==set(data['sample']) and len(run['performance'])==3
first=read('results/web-baseline-receipt.json')
assert datetime.datetime.fromisoformat(refs['createdAt'])<=datetime.datetime.fromisoformat(first['startedAt'])
screen=read('results/screenai-all.json');assert screen['version']==[153,4] and len(screen['pages'])==17
for row in screen['results']+screen['pages']:assert (OUT/'screenai-protobuf'/f'{row["id"]}.pb').stat().st_size==row['rawBytes']
throughput=read('results/throughput.json');assert throughput['status']=='complete'
for c in throughput['configurations']:
    assert c['status']=='complete' and len(c['runs'])==3
    for r in c['runs']:
        assert r['tokenParity']['identical']
        assert len({x['pid'] for x in r['results']})==c['workers']
portable=read('portable/result.json');web=read('results/web-portable.json');control=read('results/screenai-portable.json')
assert portable['status']=='native-probe-complete' and web['status']=='complete' and control['status']=='complete'
assert len(portable['samples'])==len(web['results'])==len(control['results'])==8
for attempt in portable['attempts']:
    if attempt.get('sha256'):assert sha(OUT/f'portable/hanijpan-{attempt["tool"]}.onnx')==attempt['sha256']
summary=read('summary.json');assert summary['portableCounts']['onnxNativeWebArgmaxParity']==8
assert all(summary['metrics'][n]['tokenParity']['identical'] for n in ['native-kv-all','web-kv-t4'])
manifest=read('manifest.json')
for name,digest in manifest['scripts'].items():assert sha(ROOT/name)==digest
save('validation.json',{'status':'passed','chapterPages':17,'datasetRows':len(ids),'fullRunsChecked':complete,'referenceRows':len(refs['rows']),'humanGold':False,'portableProbeRows':8,'checks':['private input and all crop/tensor hashes','pinned models and external sources','pre-inference reference timestamp/digests','full output coverage and warm-run coverage','WASM pthread creation and loopback request receipts','all Screen AI protobuf sizes','parallel process participation and token parity','converted model digest and native/Web probe coverage','current script manifest']})
print('Artifact validation passed; no inference rerun.')
