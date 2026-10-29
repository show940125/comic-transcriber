"""Freeze an independently prepared private visual-reference draft before inference.

Chapter text stays under ignored artifacts, never embedded in reusable source.
The original executed transcription helper is preserved privately for provenance.
"""
import json,time
from PIL import Image
from prepare import OUT,save,crop_record,sha

receipt_path=OUT/'freeze-receipt.json'
if receipt_path.exists():
    receipt=json.loads(receipt_path.read_text('utf-8'))
    if sha(OUT/'dataset.json')!=receipt['datasetSha256'] or sha(OUT/'references.json')!=receipt['referencesSha256']:
        raise SystemExit('Frozen dataset/reference changed; preserve evidence and use a separately versioned correction.')
    print('Reusing unchanged pre-inference dataset/reference freeze.')
    raise SystemExit(0)
if list((OUT/'results').glob('*.json')):
    raise SystemExit('Inference evidence already exists. Do not backdate a new reference freeze.')
data=json.loads((OUT/'dataset.json').read_text('utf-8'))
draft=json.loads((OUT/'reference-draft-before-inference.json').read_text('utf-8'))
rows=draft['rows']
if [r['id'] for r in rows]!=data['sample'] or any(r['source'] is not None and not isinstance(r['source'],str) for r in rows):
    raise ValueError('Private reference draft must match the fixed sample IDs.')
correction_path=OUT/'detection-corrections.json'
corrections=json.loads(correction_path.read_text('utf-8'))['corrections'] if correction_path.exists() else []
for correction in corrections:
    if any(r['id']==correction['id'] for r in data['records']):continue
    image=Image.open(OUT/f'pages/{correction["page"]:02}.jpg')
    data['records'].append(crop_record(image,correction['box'],correction['id'],dataset='real',page=correction['page'],section='body',kind='free',detectorScore=None,reference=None,referenceStatus='manual-missed-region-no-gold',manualAddition=True))
save('dataset.json',data)
save('references.json',{'status':'frozen-before-inference','createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'humanGold':False,'rows':rows,'reviewNotes':'AI visual reference draft, prepared before OCR outputs; pending human review.'})
save('freeze-receipt.json',{'datasetSha256':sha(OUT/'dataset.json'),'referencesSha256':sha(OUT/'references.json'),'beforeInference':True})
print('Reference freeze saved; no text recognition was run.')
