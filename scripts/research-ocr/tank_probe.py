"""Build a finite probe around pinned Tank-OCR engine code in a private cache."""
import hashlib,io,json,os,subprocess,urllib.request,zipfile
from pathlib import Path
from PIL import Image
from prepare import ROOT,OUT,save,sha
def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'comic-transcriber-research'}),timeout=120) as r:return r.read()
dest=OUT/'external/Tank-OCR';receipt={'status':'running','scope':'finite Go FFI probe; no HTTP listener or installation'}
try:
    meta=json.loads(fetch('https://api.github.com/repos/tanktangmold/Tank-OCR/commits/main'));commit=meta['sha'];receipt['commit']=commit
    if not dest.exists():
        with zipfile.ZipFile(io.BytesIO(fetch(f'https://api.github.com/repos/tanktangmold/Tank-OCR/zipball/{commit}'))) as z:
            prefix=z.namelist()[0].split('/')[0]+'/'
            for item in z.infolist():
                rel=Path(item.filename.removeprefix(prefix))
                if item.is_dir() or '..' in rel.parts:continue
                path=dest/rel;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(z.read(item))
    receipt['upstreamFiles']={str(p.relative_to(dest)):sha(p) for p in dest.rglob('*') if p.is_file()}
    sdk=ROOT/'.cache/research-go';go=sdk/'go/bin/go.exe'
    if not go.exists():
        release=next(r for r in json.loads(fetch('https://go.dev/dl/?mode=json')) if r['stable']);spec=next(f for f in release['files'] if f['os']=='windows' and f['arch']=='amd64' and f['kind']=='archive')
        receipt['sdk']=spec;print('Downloading verified portable Go SDK',spec['filename'],flush=True);data=fetch('https://go.dev/dl/'+spec['filename']);assert hashlib.sha256(data).hexdigest()==spec['sha256'];sdk.mkdir(parents=True,exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for item in z.infolist():
                if '..' in Path(item.filename).parts or Path(item.filename).is_absolute():raise ValueError('Unsafe SDK archive path')
            z.extractall(sdk)
    probe=dest/'cmd/comic-probe';probe.mkdir(parents=True,exist_ok=True)
    probe.joinpath('main.go').write_text('''package main
import("encoding/json";"fmt";"os";"tank-ocr/engine")
func main(){e:=engine.NewScreenAiEngine(os.Args[1]);if err:=e.Init();err!=nil{panic(err)};defer e.Close();v,err:=e.Version();if err!=nil{panic(err)};data,err:=os.ReadFile(os.Args[2]);if err!=nil{panic(err)};var rows []engine.OcrResult;for i:=0;i<3;i++{r,err:=e.PerformOcr(data,160,160,false);if err!=nil{panic(err)};rows=append(rows,*r)};out,_:=json.Marshal(map[string]interface{}{"version":v,"results":rows});fmt.Printf("TANK_PROBE=%s\\n",out)}
''',encoding='utf-8')
    row=json.loads((OUT/'dataset.json').read_text())['records'][0];image=Image.open(OUT/row['crop']).convert('RGBA').resize((160,160));raw=OUT/'combo/tank-input.bgra';raw.write_bytes(image.tobytes('raw','BGRA'))
    env=os.environ.copy();env.update(GOPATH=str(ROOT/'.cache/research-go-path'),GOCACHE=str(ROOT/'.cache/research-go-build'),GOMODCACHE=str(ROOT/'.cache/research-go-mod'),GOTOOLCHAIN='local',CGO_ENABLED='0')
    exe=OUT/'combo/tank-probe.exe';build=subprocess.run([str(go),'build','-o',str(exe),'./cmd/comic-probe'],cwd=dest,env=env,capture_output=True,text=True);(OUT/'combo/tank-build.log').write_text(build.stdout+build.stderr,encoding='utf-8');receipt['buildExit']=build.returncode
    if build.returncode:receipt['status']='build-failed'
    else:
        receipt['exeSha256']=sha(exe);screen=Path.home()/'AppData/Local/Google/Chrome/User Data/screen_ai/153.4';run=subprocess.run([str(exe),str(screen),str(raw)],cwd=dest,capture_output=True);(OUT/'combo/tank-stdout.log').write_bytes(run.stdout);(OUT/'combo/tank-stderr.log').write_bytes(run.stderr);receipt['exitCode']=run.returncode
        marker=next((line[len(b'TANK_PROBE='):] for line in run.stdout.splitlines() if line.startswith(b'TANK_PROBE=')),None)
        receipt['status']='complete' if run.returncode==0 and marker else 'native-probe-failed'
        if marker:receipt['probe']=json.loads(marker)
except Exception as error:receipt.update(status='failed',error=repr(error))
finally:save('combo/tank-probe.json',receipt);print(json.dumps({k:v for k,v in receipt.items() if k not in ['upstreamFiles','probe']},ensure_ascii=False))
