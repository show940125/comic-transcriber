"""Bind final local delivery to input, model, runtime, UI and source evidence."""
import datetime,json,re
from pathlib import Path
from prepare import ROOT,OUT,sha,save
def read(name):return json.loads((OUT/name).read_text('utf-8'))
data=read('dataset.json');freeze=read('freeze-receipt.json');refs=read('references.json');adoption=read('combo/adoption.json')
assert sha(OUT/'dataset.json')==freeze['datasetSha256'] and sha(OUT/'references.json')==freeze['referencesSha256']
assert not refs['humanGold'] and len(data['records'])==479 and len(data['pages'])==17
assert sha(data['zip'])==data['zipSha256']
for row in data['records']:assert sha(OUT/row['crop'])==row['cropSha256']
assert adoption['selectedInt8']=='int8' and adoption['selectedFp32']=='kv' and adoption['fp32TokenParity']['identical']
assert adoption['gates']['int8Adopt'] and not adoption['gates']['hybrid']['adopt'] and not adoption['gates']['qint8']['adopt']
expected={r['id'] for r in data['records']};sample=set(data['sample']);cases={};results={p:read(f'results/web-{p}-t4-canvas.json') for p in ['int8','kv']}
for channel in ['chromium','msedge']:
    for suffix,ids in [('t4',expected),('t1',sample),('t4-final',sample)]:
        name=f'extension-{channel}-{suffix}';case=read(f'combo/{name}.json');assert case['status']=='passed',(name,case.get('error'))
        assert not case['errors'] and not case['externalRequests'] and len(case['runs'])==2
        for run in case['runs']:
            assert run['status']=='complete' and {r['id'] for r in run['results']}==ids and len(run['results'])==len(ids)
            assert len(run['performance'])==3
            for perf in run['performance']:assert {r['id'] for r in perf['rows']}==sample
            runtime=run['runtime'];assert runtime['effectiveThreads']==(1 if suffix=='t1' else 4)
            assert runtime['models']==(2 if run['profile']=='int8' else 3)
            if suffix!='t1':assert runtime['spawnedPthreads']>=3
            truth={r['id']:r['source'] for r in results['int8' if run['profile']=='int8' else 'kv']['results']}
            differences=[r['id'] for r in run['results'] if r['source']!=truth[r['id']]]
            assert not differences,(name,run['profile'],differences)
        assert len(case['switchChecks'])==3
        if suffix.endswith('final'):
            assert case['manifest']['version']=='0.1.16';assert case['cancellation']['observed'] and case['cancellation']['response']['ok'] is False
            assert re.search('abort',case['cancellation']['response']['error'],re.I)
            assert 55000<=case['idleElapsedMs']<=90000
            assert any('legacy' in c for c in case['checks']) and any('resumes' in c for c in case['checks'])
        cases[name]={'sha256':sha(OUT/f'combo/{name}.json'),'rows':[(r['profile'],len(r['results'])) for r in case['runs']],'status':case['status']}
for name in ['combo/preprocess.json','combo/screenai-order.json','combo/tank-probe.json','combo/dependency-probe.json']:assert read(name)['status']=='complete',name
assert read('combo/bridge-lifecycle.json')['status']=='passed'
assert read('combo/dependency-full.json')['initialized'] and not read('combo/dependency-restricted.json')['initialized']
assert read('combo/tank-probe.json')['probe']['version']=='153.4'
lock=json.loads((ROOT/'src/model-lock.json').read_text());manifest=json.loads((ROOT/'.output/chrome-mv3/manifest.json').read_text());assert manifest['version']=='0.1.16'
refs=list(lock['ocrProfiles']['int8'].values());refs=[r for r in refs if isinstance(r,dict)]
refs +=[{'model':'detector','file':f['name']} for f in next(m for m in lock['vision'] if m['id']=='detector')['files']]
model_paths=set()
for ref in refs:
    file=next(f for m in lock['vision'] if m['id']==ref['model'] for f in m['files'] if f['name']==ref['file']);path=ROOT/f'.output/chrome-mv3/models/{ref["model"]}/{ref["file"]}'
    assert sha(path)==file['sha256'] and path.stat().st_size==file['bytes'];model_paths.add(path.resolve())
assert {p.resolve() for p in (ROOT/'.output/chrome-mv3/models').rglob('*') if p.is_file()}==model_paths
executed={}
for path in (ROOT/'.output/chrome-mv3').rglob('*'):
    if not path.is_file():continue
    rel=path.relative_to(ROOT/'.output/chrome-mv3');peer=OUT/'test-extension-final'/rel
    assert peer.exists() and sha(peer)==sha(path),str(rel);executed[str(rel).replace('\\','/')]=sha(path)
delivery=json.loads((ROOT/'artifacts/zip-verification.json').read_text());assert delivery['version']=='0.1.16' and delivery['status']=='passed'
assert sha(ROOT/delivery['path'])==delivery['sha256']
qa=read('optimization-ui-verification.json');assert qa['status']=='passed' and sha(OUT/'optimization.html')==qa['htmlSha256']
live=read('live-chrome/acceptance.json');assert live['status']=='partial' and live['final_build_user_reload_confirmed']
tests=(ROOT/'artifacts/ocr-optimization-tests.log').read_text('utf-8');assert re.search(r'pass\s+146',tests) and re.search(r'fail\s+0',tests)
files=[p for folder in ['src','entrypoints','scripts/research-ocr'] for p in (ROOT/folder).rglob('*') if p.is_file() and p.suffix in ['.ts','.svelte','.py','.mjs','.js','.json','.txt']]
files +=[ROOT/p for p in ['package.json','package-lock.json','NOTICE.md','scripts/stage-vision.mjs','scripts/audit-package.mjs','scripts/prepare-assets.mjs','scripts/download-vision.py']]
save('implementation-manifest.json',{'status':'passed','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'local OCR implementation and delivery; live Chrome partial retained','inputSha256':data['zipSha256'],'datasetSha256':sha(OUT/'dataset.json'),'referencesSha256':sha(OUT/'references.json'),'humanGold':False,'sourceHashes':{str(p.relative_to(ROOT)).replace('\\','/'):sha(p) for p in files},'executedFinalBuild':executed,'cases':cases,'adoptionSha256':sha(OUT/'combo/adoption.json'),'tests':{'passed':146,'logSha256':sha(ROOT/'artifacts/ocr-optimization-tests.log')},'delivery':delivery,'reportSha256':sha(OUT/'optimization.html'),'qa':qa,'liveChrome':{'status':live['status'],'sha256':sha(OUT/'live-chrome/acceptance.json'),'tester':'gpt-6.1-terra','reasoningEffort':'medium','versionEvidence':'user-confirmed reload of final local build'}})
print('Implementation evidence passed: isolated routes, final cancellation/legacy/idle, delivery and live partial boundaries.')
