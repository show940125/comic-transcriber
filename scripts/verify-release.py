"""Check a staged release without extracting files or loading weights into RAM."""
import json, sys, zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    bad = archive.testzip()
    if bad:
        raise RuntimeError('ZIP CRC mismatch: ' + bad)
    manifest = json.loads(archive.read('manifest.json'))
    if manifest['version'] != sys.argv[2]:
        raise RuntimeError('Release manifest version mismatch')
    for required in ('LICENSE', 'NOTICE.md', 'offscreen.html', 'reader.html'):
        archive.getinfo(required)
print('Release CRC, manifest and required files verified')
