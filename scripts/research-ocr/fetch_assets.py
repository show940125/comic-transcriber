"""Download pinned research candidates, preserving upstream source/license provenance."""
from pathlib import Path
import hashlib,json,urllib.request,zipfile,io,time
from prepare import OUT,ROOT,save,sha

if (OUT/'asset-lock.json').exists():
    existing=json.loads((OUT/'asset-lock.json').read_text('utf-8'))
    for entry in existing['sources']:
        if entry.get('sha256') and sha(ROOT/entry['path'])!=entry['sha256']:raise ValueError('Pinned asset changed: '+entry['path'])
        if entry['kind']=='external-source':
            for name,digest in entry['files'].items():
                if sha(ROOT/entry['path']/name)!=digest:raise ValueError('Pinned source changed: '+name)
    print('Reusing verified asset-lock; no new download or revision lookup.')
    raise SystemExit(0)

def get(url):
    request=urllib.request.Request(url,headers={'User-Agent':'comic-transcriber-research/1'})
    with urllib.request.urlopen(request,timeout=120) as response:return response.read()
def metadata(url):return json.loads(get(url))
def download(url,path,expected=None):
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists() and (expected is None or sha(path)==expected):return
    print('Download',path.name,flush=True)
    data=get(url)
    if expected and hashlib.sha256(data).hexdigest()!=expected:raise ValueError('Digest mismatch '+path.name)
    temp=path.with_suffix(path.suffix+'.partial');temp.write_bytes(data);temp.replace(path)

lock={'createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'sources':[]}
repo='ogkalu/manga-ocr-onnx'; info=metadata(f'https://huggingface.co/api/models/{repo}');revision=info['sha']
tree=metadata(f'https://huggingface.co/api/models/{repo}/tree/{revision}')
for name in ['encoder_model_int8.onnx','decoder_model_int8.onnx','vocab.txt']:
    spec=next(r for r in tree if r['path']==name);expected=spec.get('lfs',{}).get('oid')
    url=f'https://huggingface.co/{repo}/resolve/{revision}/{name}?download=true';path=OUT/'models/int8'/name
    download(url,path,expected);lock['sources'].append({'kind':'model','repo':repo,'revision':revision,'url':url,'path':str(path.relative_to(ROOT)),'sha256':sha(path),'bytes':path.stat().st_size,'license':'upstream declares Apache-2.0'})
release=metadata('https://api.github.com/repos/hajisensai/Fushi/releases/tags/manga-ocr-kv-onnx-v1')
save('upstream-fushi-release.json',release)
for asset in release['assets']:
    if asset['name'] not in {'cross_kv.onnx','decoder_kv.onnx'}:continue
    expected=asset.get('digest');expected=expected.split(':',1)[1] if expected else None
    path=OUT/'models/kv'/asset['name'];download(asset['browser_download_url'],path,expected)
    lock['sources'].append({'kind':'model','repo':'hajisensai/Fushi','tag':release['tag_name'],'url':asset['browser_download_url'],'path':str(path.relative_to(ROOT)),'sha256':sha(path),'bytes':path.stat().st_size,'license':'release declares Apache-2.0 model lineage'})
repo='sergiocorreia/clv-locro';info=metadata(f'https://api.github.com/repos/{repo}/commits/master');revision=info['sha']
dest=OUT/'external/clv-locro'
if not dest.exists():
    data=get(f'https://api.github.com/repos/{repo}/zipball/{revision}')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        prefix=archive.namelist()[0].split('/')[0]+'/'
        for item in archive.infolist():
            rel=Path(item.filename.removeprefix(prefix))
            if item.is_dir() or '..' in rel.parts:continue
            p=dest/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(archive.read(item))
lock['sources'].append({'kind':'external-source','repo':repo,'revision':revision,'path':str(dest.relative_to(ROOT)),'license':'MIT, preserved LICENSE','files':{str(p.relative_to(dest)):sha(p) for p in dest.rglob('*') if p.is_file()}})
for p in (ROOT/'.cache/models/manga-ocr').iterdir():
    if p.is_file():lock['sources'].append({'kind':'baseline','path':str(p.relative_to(ROOT)),'sha256':sha(p),'bytes':p.stat().st_size})
screen=Path.home()/'AppData/Local/Google/Chrome/User Data/screen_ai/153.4'
lock['screenAI']={'path':str(screen),'manifest':json.loads((screen/'manifest.json').read_text()),'files':{str(p.relative_to(screen)):sha(p) for p in screen.rglob('*') if p.is_file()}}
save('asset-lock.json',lock)
print('Research assets frozen.',flush=True)
