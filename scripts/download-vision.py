"""Download fixed-revision vision assets and verify SHA-256. No model execution."""
import argparse, hashlib, json, pathlib, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]
lock = json.loads((ROOT / 'src/model-lock.json').read_text(encoding='utf-8'))
parser=argparse.ArgumentParser();parser.add_argument('--profile',choices=['int8','fp32','all'],default='int8');args=parser.parse_args()
refs=[] if args.profile=='all' else list(lock['ocrProfiles'][args.profile].values())
selected={(r['model'],r['file']) for r in refs if isinstance(r,dict)}
for model in lock['vision']:
    dest = ROOT / '.cache/models' / model['id']
    dest.mkdir(parents=True, exist_ok=True)
    for entry in model['files']:
        if args.profile!='all' and model['id']!='detector' and (model['id'],entry['name']) not in selected:continue
        path = dest / entry['name']
        valid = path.exists() and (not entry['sha256'] or hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() == entry['sha256'])
        if not valid:
            print('Downloading', entry['name'], entry['bytes'], flush=True)
            partial = path.with_suffix('.partial')
            with urllib.request.urlopen(entry['url'], timeout=120) as response, partial.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if entry['sha256'] and hashlib.file_digest(partial.open('rb'), 'sha256').hexdigest() != entry['sha256']:
                raise RuntimeError('Hash mismatch: ' + entry['name'])
            partial.replace(path)
        print('Verified', entry['name'], path.stat().st_size, flush=True)
