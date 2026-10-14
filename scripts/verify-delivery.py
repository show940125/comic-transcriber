"""Verify the actual release ZIP and record reproducible delivery identities."""
import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
target = root / 'dist' / f'comic-transcriber-{version}-offline-vision.zip'

def identity(path):
    with path.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    return {'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest}

with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None, 'ZIP CRC failure'
    names = archive.namelist()
    manifest = json.loads(archive.read('manifest.json'))
    assert manifest['version'] == version and manifest['manifest_version'] == 3
    assert archive.read('manifest.json') == (root / '.output/chrome-mv3/manifest.json').read_bytes()
    assert any('encoder' in name and name.endswith('.onnx') for name in names)
    assert any('decoder' in name and name.endswith('.onnx') for name in names)
    assert any('detector' in name and name.endswith('.onnx') for name in names)
    assert not any('paddle' in name.lower() or 'real-corpus' in name or name.endswith('.gguf') for name in names)
    assert 'LICENSE' in names and 'NOTICE.md' in names
    assert archive.read('NOTICE.md') == (root / 'NOTICE.md').read_bytes()

zip_identity = identity(target)
result = {'status': 'passed', 'version': version, 'crcAllEntries': True,
          'files': len(names), **zip_identity, 'mangaImagesExcluded': True,
          'optionalGGUFExcluded': True, 'manifestMatchesBuild': True}
(root / 'artifacts/zip-verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
delivery = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'artifacts': [zip_identity,
            identity(root / '.output/chrome-mv3/manifest.json'), identity(root / 'artifacts/package-audit.json')]}
(root / 'artifacts/delivery-manifest.json').write_text(json.dumps(delivery, indent=2), encoding='utf-8')
print(json.dumps(result))
