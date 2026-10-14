"""Author-published, licensed original manga sample. Local research only."""
import hashlib,json,pathlib,urllib.request,zipfile,shutil,subprocess,argparse,re
ROOT=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--pages',type=int,default=40);args=parser.parse_args()
cache=ROOT/'.cache/corpus';cache.mkdir(parents=True,exist_ok=True)
out=ROOT/'artifacts/real-corpus';(out/'pages').mkdir(parents=True,exist_ok=True)
source='https://densho810.com/free/dl/001bj.zip';target=cache/'001bj.zip'
if not target.exists():
    partial=target.with_suffix('.zip.partial')
    print('Downloading author-published volume 1, 343 MB; local research, no publication.',flush=True)
    total=0;next_progress=32*1024*1024
    with urllib.request.urlopen(source,timeout=120) as response,partial.open('wb') as output:
        expected=int(response.headers.get('Content-Length','0'))
        while chunk:=response.read(1024*1024):
            output.write(chunk);total+=len(chunk)
            if total>=next_progress:print(f'Downloaded {total//1048576} MiB',flush=True);next_progress+=32*1024*1024
        if expected and expected!=total:raise RuntimeError('Incomplete download')
    partial.replace(target)
with zipfile.ZipFile(target) as archive:
    bad=archive.testzip()
    if bad:raise RuntimeError('ZIP integrity error: '+bad)
    names=[n for n in archive.namelist() if n.lower().endswith('.pdf')]
    if len(names)!=1:raise RuntimeError('Expected one original PDF')
    pdf=cache/'volume-01.pdf'
    if not pdf.exists():pdf.write_bytes(archive.read(names[0]))
terms=urllib.request.urlopen('https://densho810.com/free/',timeout=30).read()
(out/'license-source.html').write_bytes(terms)
info=shutil.which('pdfinfo')
if not info:raise RuntimeError('Native PDF metadata tool pdfinfo is required')
metadata=subprocess.run([info,str(pdf)],capture_output=True,check=True).stdout.decode('utf-8',errors='replace')
pdf_pages=int(re.search(r'^Pages:\s+(\d+)',metadata,re.M).group(1))
manifest={'schema':1,'title':'ブラックジャックによろしく','author':'佐藤秀峰','credit':'Give My Regards to Black Jack / SHUHO SATO','source':source,'terms':'https://densho810.com/free/','rights':'author-published volume 1 permitted under source terms; attribution required; public derivative release requires subsequent report; no public release performed','zipSha256':hashlib.file_digest(target.open('rb'),'sha256').hexdigest(),'pdfSha256':hashlib.file_digest(pdf.open('rb'),'sha256').hexdigest(),'originalPdfPages':pdf_pages,'groundTruth':'unreviewed; detected boxes and OCR are candidates, not independent labels','pages':[]}
# Contiguous PDF pages, including front matter, avoid choosing
# easy pages based on model predictions. Covers/blank pages remain in the sample.
poppler=shutil.which('pdftoppm')
if not poppler:raise RuntimeError('Native PDF renderer pdftoppm is required')
subprocess.run([poppler,'-f','1','-l',str(min(args.pages,pdf_pages)),'-scale-to','1600','-png',str(pdf),str(out/'pages/page')],check=True)
from PIL import Image
for index in range(min(args.pages,pdf_pages)):
    filename=f'pages/page-{index+1:03}.png';path=out/filename
    with Image.open(path) as image:width,height=image.size
    manifest['pages'].append({'file':filename,'pdfPage':index+1,'width':width,'height':height,'sha256':hashlib.file_digest(path.open('rb'),'sha256').hexdigest()})
manifest['renderer']='native Poppler pdftoppm; max dimension 1600px'
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
(out/'README.md').write_text(f'# Real manga research sample\n\nGive My Regards to Black Jack / SHUHO SATO\n\nAuthor-published Japanese volume 1, first {len(manifest["pages"])} PDF pages in order. Source and terms: https://densho810.com/free/\n\nLocal research and evaluation only. Images are not bundled in the extension ZIP. Candidate detection/OCR is not independent ground truth. Public derivative publication and any required author notification remain outside this local task.\n',encoding='utf-8')
print(json.dumps({'pages':len(manifest['pages']),'pdfPages':pdf_pages,'zipSha256':manifest['zipSha256']},ensure_ascii=False),flush=True)
