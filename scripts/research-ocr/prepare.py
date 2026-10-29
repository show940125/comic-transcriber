"""Freeze private fixtures and detector output; never runs text recognition."""
from pathlib import Path
import argparse, hashlib, io, json, math, sys, time, zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/research-ocr'
sys.path.insert(0, str(ROOT / 'backend'))

def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def save(name, value):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.partial')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)

def crop_record(image, box, rid, **metadata):
    rect = box.get('ocrBox') or box
    x, y = max(0, int(rect['x'])), max(0, int(rect['y']))
    right = min(image.width, math.ceil(rect['x'] + rect['width']))
    bottom = min(image.height, math.ceil(rect['y'] + rect['height']))
    crop = image.crop((x, y, right, bottom)).convert('RGB')
    filename = f'crops/{rid}.png'
    crop.save(OUT / filename)
    gray = ImageOps.grayscale(crop).resize((224, 224), Image.Resampling.BILINEAR)
    plane = (np.asarray(gray, dtype=np.float32) / 255 - .5) * 2
    tensor = np.stack([plane] * 3)[None].astype('<f4')
    tensor.tofile(OUT / f'tensors/{rid}.f32')
    return {'id': rid, 'crop': filename, 'tensor': f'tensors/{rid}.f32',
            'cropSha256': sha(OUT / filename), 'tensorSha256': sha(OUT / f'tensors/{rid}.f32'),
            'box': {'x': x, 'y': y, 'width': right-x, 'height': bottom-y},
            'skipBlank': bool(np.count_nonzero(plane < -.2157) < 24 or np.count_nonzero(plane > .2157) < 24), **metadata}

def main():
    from vision import Vision
    parser = argparse.ArgumentParser()
    parser.add_argument('zip', type=Path)
    args = parser.parse_args()
    if (OUT / 'dataset.json').exists():
        raise SystemExit('Frozen dataset exists; verify/reuse it instead of detecting again.')
    for name in ['pages', 'overlays', 'crops', 'tensors', 'contacts', 'results', 'models', 'external']:
        (OUT / name).mkdir(parents=True, exist_ok=True)
    vision = Vision(1)
    pages, records = [], []
    with zipfile.ZipFile(args.zip) as archive:
        images = sorted(n for n in archive.namelist() if Path(n).suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'})
        for index, name in enumerate(images, 1):
            data = archive.read(name)
            image = Image.open(io.BytesIO(data)).convert('RGB')
            pagefile = f'pages/{index:02}.jpg'
            (OUT / pagefile).write_bytes(data)
            started = time.perf_counter()
            detections = sorted(vision.detect(image), key=lambda r: (int(r['y']/100), -r['x']))
            overlay = image.copy(); draw = ImageDraw.Draw(overlay)
            rows = []
            for j, region in enumerate(detections, 1):
                rid = f'real-p{index:02}-r{j:02}'
                row = crop_record(image, region, rid, dataset='real', page=index,
                                  section='advert' if index == 1 else 'title' if index == 2 else 'body',
                                  kind=region['kind'], detectorScore=region['score'], detectorRegion=region,
                                  reference=None, referenceStatus='not-annotated')
                records.append(row); rows.append(rid)
                r = row['box']; draw.rectangle((r['x'], r['y'], r['x']+r['width'], r['y']+r['height']), outline='red', width=2)
                draw.text((r['x'], max(0, r['y']-12)), str(j), fill='blue', stroke_fill='white', stroke_width=1)
            overlay.save(OUT / f'overlays/{index:02}.png')
            pages.append({'page': index, 'file': pagefile, 'zipEntry': name, 'sha256': hashlib.sha256(data).hexdigest(),
                          'width': image.width, 'height': image.height, 'regions': rows, 'detectMs': (time.perf_counter()-started)*1000})
            print(f'detected page {index}: {len(rows)} regions', flush=True)
    synthetic = json.loads((ROOT / 'artifacts/corpus/manifest-annotation-v1.json').read_text('utf-8'))
    for index, page in enumerate(synthetic['pages'], 1):
        image = Image.open(ROOT / 'artifacts/corpus' / page['file']).convert('RGB')
        assert sha(ROOT / 'artifacts/corpus' / page['file']) == page['sha256']
        for region in page['regions']:
            records.append(crop_record(image, region, f'syn-{region["id"]}', dataset='synthetic', page=index,
                                       category=page['category'], reference=region['source'], referenceStatus='synthetic-known-source'))
        records.append(crop_record(image, page['blank'], f'blank-p{index:02}', dataset='blank', page=index,
                                   category=page['category'], reference='', referenceStatus='synthetic-blank'))
    body = [r for r in records if r['dataset'] == 'real' and r['section'] == 'body']
    # Stratified across pages, with wide/tall/free-text examples retained.
    sample = []
    for page in range(3, len(pages)+1):
        rows = [r for r in body if r['page'] == page]
        for row in rows[:3]:
            if row['id'] not in sample: sample.append(row['id'])
    for row in sorted(body, key=lambda r: (-int(r['kind']=='free'), -r['box']['height']/max(1,r['box']['width']))):
        if len(sample) >= 50: break
        if row['id'] not in sample: sample.append(row['id'])
    for start in range(0, len(sample), 10):
        canvas = Image.new('RGB', (1200, 5*400), '#dddddd'); draw = ImageDraw.Draw(canvas)
        for j, rid in enumerate(sample[start:start+10]):
            row = next(r for r in records if r['id'] == rid)
            image = Image.open(OUT / row['crop']); image.thumbnail((570, 360))
            x, y = (j % 2)*600, (j // 2)*400
            draw.text((x+8,y+4), rid, fill='black'); canvas.paste(image,(x+8,y+30))
        canvas.save(OUT / f'contacts/sample-{start//10+1:02}.jpg')
    dataset = {'schema': 1, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'zip': str(args.zip), 'zipSha256': sha(args.zip), 'pages': pages, 'records': records,
               'sample': sample, 'detector': {'path': '.cache/models/detector/detector-v4-s_int8.onnx',
                 'sha256': sha(ROOT / '.cache/models/detector/detector-v4-s_int8.onnx'), 'runtime': 'onnxruntime CPU 1 thread'},
               'preprocessing': 'frozen RGB PNG crop; Pillow grayscale/BILINEAR 224x224, float32 [-1,1] x3; identical tensors across native/web MangaOCR',
               'referenceBoundary': 'Real references must be frozen before viewing OCR; AI reviewed, not human gold.'}
    save('dataset.json', dataset)
    save('references.json', {'status': 'pending-before-inference', 'rows': [{'id': rid, 'source': None, 'tags': [], 'status': 'pending'} for rid in sample]})
    print(json.dumps({'pages':len(pages),'real':len(body),'allRecords':len(records),'sample':len(sample)}), flush=True)

if __name__ == '__main__': main()
