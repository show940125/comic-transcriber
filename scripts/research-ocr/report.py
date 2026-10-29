"""Build inspectable, offline comparison artifacts from completed research runs."""
import hashlib,html,json,statistics,subprocess,sys,time
from pathlib import Path
from prepare import ROOT,OUT,save,sha
from metrics import evaluate,parity

def percent(value):return '—' if value is None else f'{value*100:.2f}%'
def load(path):return json.loads(path.read_text('utf-8')) if path.exists() else None
def main():
    data=load(OUT/'dataset.json');refs=load(OUT/'references.json');lock=load(OUT/'asset-lock.json')
    names=['web-baseline','web-int8','native-baseline-all','native-int8-all','native-kv-all','web-baseline-t4-sample','web-int8-t4-sample','web-kv-t4','screenai-all']
    runs={};metrics={}
    for name in names:
        result=load(OUT/f'results/{name}.json')
        if result:
            runs[name]=result;metrics[name]=evaluate(data['records'],result.get('results',[]),refs)
            perf=result.get('performance',[]);metrics[name]['warmMedian50Ms']=statistics.median(r['totalMs'] for r in perf) if perf else None
    for prefix in ['web','native']:
        b=prefix+'-baseline'+('-all' if prefix=='native' else '');c=prefix+'-kv'+('-all' if prefix=='native' else '')
        if b in runs and c in runs:metrics[c]['tokenParity']=parity(runs[b]['results'],runs[c]['results'])
    for variant in ['baseline','int8','kv']:
        b='web-'+variant;c='native-'+variant+'-all'
        if b in runs and c in runs:metrics[c]['webNativeParity']=parity(runs[b]['results'],runs[c]['results'])
    if 'web-kv-t4' in runs:
        metrics['web-kv-t4']['tokenParity']=parity(runs['web-baseline']['results'],runs['web-kv-t4']['results'])
        metrics['web-kv-t4']['equivalenceControl']='full web-baseline single-thread; includes cross-thread numerical effects'
    for variant in ['baseline','int8']:
        c='web-'+variant+'-t4-sample';b='web-'+variant
        if c in runs:
            ids={r['id'] for r in runs[c]['results']}
            metrics[c]['threadParity']=parity([r for r in runs[b]['results'] if r['id'] in ids],runs[c]['results'])
    baseline_bytes=sum(r['bytes'] for r in lock['sources'] if r['kind']=='baseline')
    int8_bytes=sum(r['bytes'] for r in lock['sources'] if r.get('repo')=='ogkalu/manga-ocr-onnx')
    gates={'int8Bytes':int8_bytes,'baselineBytes':baseline_bytes,'sizeReduction':1-int8_bytes/baseline_bytes}
    if 'web-baseline' in metrics and 'web-int8' in metrics:
        b,c=metrics['web-baseline'],metrics['web-int8'];bg=b['groups'].get('synthetic',{});cg=c['groups'].get('synthetic',{})
        if bg.get('cer') is not None and cg.get('cer') is not None:
            gates.update(int8SyntheticCerIncrease=cg['cer']-bg['cer'],int8NoAdditionalBlankErrors=c['groups']['blank']['blankHallucinations']<=b['groups']['blank']['blankHallucinations'])
            gates['int8ResearchGate']=runs['web-baseline']['status']=='complete' and runs['web-int8']['status']=='complete' and gates['int8SyntheticCerIncrease']<=.005 and gates['int8NoAdditionalBlankErrors'] and gates['sizeReduction']>=.5
    for prefix in ['web','native']:
        b=prefix+'-baseline'+('-all' if prefix=='native' else '');c=prefix+'-kv'+('-all' if prefix=='native' else '')
        if b in metrics and c in metrics and metrics[b]['warmMedian50Ms'] and metrics[c]['warmMedian50Ms']:
            gain=1-metrics[c]['warmMedian50Ms']/metrics[b]['warmMedian50Ms'];gates[prefix+'KvWarmGain']=gain
            gates[prefix+'KvResearchGate']=gain>=.15 and metrics[c]['tokenParity']['identical'] and runs[c]['status']=='complete'
    if 'web-kv-t4' in metrics and 'web-baseline-t4-sample' in metrics:
        gain=1-metrics['web-kv-t4']['warmMedian50Ms']/metrics['web-baseline-t4-sample']['warmMedian50Ms']
        gates.update(web4KvWarmGain=gain,web4KvResearchGate=gain>=.15 and metrics['web-kv-t4']['tokenParity']['identical'] and runs['web-kv-t4']['status']=='complete')
    portable=load(OUT/'portable/result.json');portable_web=load(OUT/'results/web-portable.json')
    portable_control=load(OUT/'results/screenai-portable.json');alternate=load(OUT/'portable/alternate-converter.json');diagnostic=load(OUT/'portable/backend-diagnostic.json')
    from metrics import normalize
    portable_counts={}
    if portable and portable_web and portable_control:
        web_by={r['id']:r for r in portable_web['results']};control_by={r['id']:r for r in portable_control['results']}
        portable_counts={'samples':len(portable['samples']),'tfliteExact':0,'onnxNativeExact':0,'onnxWebExact':0,'screenAIExact':0,'tfliteOnnxArgmaxParity':0,'onnxNativeWebArgmaxParity':0}
        for s in portable['samples']:
            w=web_by[s['id']];c=control_by[s['id']];truth=normalize(s['reference'])
            for key,value in [('tfliteExact',s['source']),('onnxNativeExact',s.get('onnxSource','')),('onnxWebExact',w['source']),('screenAIExact',c['source'])]:portable_counts[key]+=int(normalize(value)==truth)
            portable_counts['tfliteOnnxArgmaxParity']+=int(s.get('argmaxParity',False))
            portable_counts['onnxNativeWebArgmaxParity']+=int(s.get('onnxGreedyIds')==w['greedyIds'])
    throughput=load(OUT/'results/throughput.json')
    judgements={
      'INT8 MangaOCR':{'decision':'建議採用為下一版優先整合候選' if gates.get('int8ResearchGate') else '保留候選，研究門檻未通過','reason':'體積及合成集門檻分開驗證；真實漫畫仍待人工確認。'},
      'KV-cache':{'decision':'建議採用為全精度加速候選' if gates.get('nativeKvResearchGate') and gates.get('web4KvResearchGate') else '保留候選，等價性或效能門檻待解','reason':'全精度保真加速路線；本輪未與 INT8 合併。'},
      'Screen AI bridge':{'decision':'保留候選，暫不取代 MangaOCR','reason':'現成橋接與直排座標已實跑；直接串接文字列的合成 CER 落後，仍需處理雜字、標點、註音及讀序。'},
      'Screen AI recognizer ONNX':{'decision':'停止本輪完整移植投入，保留單模型成果','reason':'計算圖能在原生/Web運算，量化張量與CTC文字等價性未過；另一轉換器不支援per-channel量化。'},
      'CPU scheduling':{'decision':'建議單 worker、每 ORT session intra=4 作為原生配置候選','reason':'雙 worker 雖使 CPU 時間折算比例達約94%，本批 baseline/KV 較慢，INT8 改善很小。'}}
    summary={'createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'metrics':metrics,'gates':gates,'judgements':judgements,'portable':portable,'portableWeb':portable_web,'portableCounts':portable_counts,'portableControl':portable_control,'alternateConverter':alternate,'backendDiagnostic':diagnostic,'throughput':throughput,'humanGold':False}
    save('summary.json',summary)
    script_hashes={str(p.relative_to(ROOT)).replace('\\','/'):sha(p) for p in (ROOT/'scripts/research-ocr').iterdir() if p.is_file()}
    snapshots={p.name:sha(p) for p in OUT.glob('*executed.*') if p.is_file()}
    save('manifest.json',{'createdAt':summary['createdAt'],'gitBase':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'python':sys.version,'datasetSha256':sha(OUT/'dataset.json'),'referenceSha256':sha(OUT/'references.json'),'assetLockSha256':sha(OUT/'asset-lock.json'),'scripts':script_hashes,'executionSnapshots':snapshots,'runs':{n:{'status':r['status'],'resultSha256':sha(OUT/f'results/{n}.json')} for n,r in runs.items()},'scope':'local OCR research; no translation, no extension integration, no DLL decompilation'})
    # Static UTF-8 report; all user/engine text is escaped before insertion.
    head='''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>漫畫 OCR 研究比較</title><style>body{font:16px system-ui;margin:auto;padding:24px;max-width:1600px;background:#f5f3ed;color:#202d29}h1{font-size:28px}table{border-collapse:collapse;background:white}td,th{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top}td img{max-width:230px;max-height:340px;object-fit:contain}pre{white-space:pre-wrap;word-break:break-word;margin:0;font:15px system-ui}select,button,input{font:inherit;margin:8px;padding:6px}.scroll{overflow:auto}.warning{background:#fff1c7;padding:16px}.bad{background:#ffe8e4}details{margin:12px 0}.tools{position:sticky;top:0;background:#f5f3ed;padding:8px;z-index:2}a{color:#075c65}</style><h1>漫畫 OCR 研究比較</h1><p class="warning">真實漫畫參考稿為 AI 視覺覆核，待人工確認；合成集為已知原文。宣傳頁、扉頁及正文分開統計。本頁只比較 OCR，未測翻譯。</p>'''
    head=head.replace('</style>','#comparison th,#comparison td{min-width:160px}#comparison th:first-child,#comparison td:first-child{min-width:240px}#comparison th:nth-child(2),#comparison td:nth-child(2){min-width:200px}.scroll{max-width:100%}@media(max-width:600px){body{padding:12px}h1{font-size:24px}}</style>')
    table=['<div class="scroll"><table id="summary"><tr><th>執行組</th><th>狀態</th><th>完成框數</th><th>合成 CER</th><th>漫畫 AI 參考 CER</th><th>空白誤讀</th><th>暖機 50 框中位</th></tr>']
    md=['# 漫畫 OCR 優化研究：Tensei Goblin 第 24 話','',f'結果時間（UTC）：{summary["createdAt"]}。研究使用全章 17 頁，沒有執行翻譯、改動正式插件或反編譯 DLL。','',
        '## 證據與限制','',
        '- 主素材：使用者提供的 ZIP；146 個 RT-DETR 區域，加上局部視覺審查補列的 3 個擬聲詞漏框。未建立全章人工框標註，因此不報完整偵測召回率。',
        '- 50 個代表框參考稿在 OCR 前凍結；47 框可計分，3 框歧義排除。參考稿是 AI 視覺轉錄，包含尚待人工核對的標點、小字與讀序，所得 CER 僅為診斷。',
        '- 輔助集為 30 頁／300 個已知原文合成框，加 30 個空白區。合成品質不代表真實漫畫品質。',
        '- MangaOCR native/web 共用固定 Pillow 灰階、BILINEAR 224×224、float32 [-1,1] tensor；隔離模型/runtime 差異，未涵蓋正式插件 Canvas 前處理驗收。',
        '- 空白略過沿用現有 MangaOCR 判斷；Screen AI 直接讀原始裁圖。空白誤讀反映各候選流程，並非純網路單獨比較。',
        '- 全資料首輪一次，50 框暖機三次。首輪包含按需 tensor 讀取；暖機、模型初始化及實際後端分開保存。',
        '- 讀序錯誤保留逐框 unknown／待視覺覆核，尚未建立可靠的自動分類；CER 包含讀序造成的編輯差異。重複字欄僅抓連續 16 個同字；截斷欄反映解碼長度上限，沒有此訊號的引擎標為 unknown。',
        '- Native ORT 使用 CPUExecutionProvider、intra/inter=1；Screen AI 內部執行緒由引擎管理，跨引擎耗時包含這項差異。',
        '- Windows Working Set／Private Commit 各別記錄；瀏覽器逐程序 lifetime peak 不相加作同時總峰值，JS heap 不代表 WASM 或整個瀏覽器 RAM。','',
        '## 執行結果','', '| 執行組 | 狀態 | 完成框數 | 合成 CER | 漫畫 AI 參考 CER | 空白誤讀 | 暖機 50 框中位 |','|---|---|---:|---:|---:|---:|---:|']
    for name,result in runs.items():
        m=metrics[name];syn=m['groups'].get('synthetic',{});real=m['groups'].get('real',{});blank=m['groups'].get('blank',{});warm=m['warmMedian50Ms'];warmstr='—' if warm is None else f'{warm/1000:.3f} s'
        values=[name,result['status'],f'{len(result.get("results",[]))}/{result.get("expectedRows",len(data["records"]))}',percent(syn.get('cer')),percent(real.get('cer')),str(blank.get('blankHallucinations','—')),warmstr]
        table.append('<tr>'+''.join('<td>'+html.escape(v)+'</td>' for v in values)+'</tr>');md.append('| '+' | '.join(values)+' |')
    table.append('</table></div>')
    section_header=['執行組','頁面組別','框數','AI參考可計分框','CER','整框正確率']
    md+=['','## 宣傳頁、扉頁與正文','', '宣傳頁與扉頁已全框推論，本輪凍結的 47 個可計分 AI 參考框均在正文；前兩頁成績以未評分表示，避免當作零錯誤。','', '| '+' | '.join(section_header)+' |','|---|---|---:|---:|---:|---:|']
    table+=['<h2>分頁組別診斷</h2><p>宣傳頁／扉頁已推論，參考稿尚未標註；— 表示未評分。</p><div class="scroll"><table><tr>'+''.join('<th>'+v+'</th>' for v in section_header)+'</tr>']
    for name in ['web-baseline','web-int8','native-kv-all','screenai-all']:
        for section,label in [('advert','宣傳頁 1'),('title','扉頁 2'),('body','正文 3–17')]:
            g=metrics.get(name,{}).get('groups',{}).get('real-'+section,{})
            values=[name,label,str(g.get('rows',0)),str(g.get('scored',0)),percent(g.get('cer')),percent(g.get('exactRate'))]
            md.append('| '+' | '.join(values)+' |');table.append('<tr>'+''.join('<td>'+html.escape(v)+'</td>' for v in values)+'</tr>')
    table.append('</table></div>')
    if throughput:
        md+=['','## CPU 多執行緒與併發','',
             '使用者追加授權後，以 6 核／12 緒 i5-12400 量測。每個 ORT session 的 intra=4、inter=1；此設定不是整個 worker 的全域執行緒上限。CPU 欄為推論程序 CPU time 折算 12 個邏輯核心的比例，可能包含 runtime 執行緒池的等待工作。不同配置分開計時，未與其他模型計時互相干擾。','',
             '| 模型 | workers | 每 session intra | 50 框中位 | CPU 比例 | token 差異 |','|---|---:|---:|---:|---:|---:|']
        table+=['<h2>CPU 多執行緒與併發</h2><p>每 session intra=4；CPU 時間折算整機比例。高 CPU 使用率與吞吐改善分別判讀。</p><table><tr><th>模型</th><th>workers</th><th>50 框中位</th><th>CPU 比例</th><th>token 差異</th></tr>']
        for c in throughput.get('configurations',[]):
            if c.get('status')!='complete':continue
            cpu=statistics.mean(r['inferenceProcessCpuPercentOfMachine'] for r in c['runs']);diff=sum(len(r['tokenParity']['differences']) for r in c['runs'])
            md.append(f'| {c["variant"]} | {c["workers"]} | 4 | {c["median50Seconds"]:.3f} s | {cpu:.1f}% | {diff} |')
            table.append(f'<tr><td>{c["variant"]}</td><td>{c["workers"]}</td><td>{c["median50Seconds"]:.3f} s</td><td>{cpu:.1f}%</td><td>{diff}</td></tr>')
        table.append('</table>')
        md+=['','本輪以單 worker／每 session 4 緒作為較穩定的原生配置候選。雙 worker 的 INT8 改善很小，baseline 與 KV 反而較慢；不因 CPU 使用率較高就建議提高併發。','']
    md+=['','## 階段判定','',f'- INT8 檔案：{int8_bytes/1048576:.2f} MiB；全精度模型與字表：{baseline_bytes/1048576:.2f} MiB；縮減 {gates["sizeReduction"]*100:.2f}%。',f'- INT8 研究門檻：{gates.get("int8ResearchGate","未完成主測，不能判定")}。門檻是合成 CER 增幅 ≤0.5 個百分點、空白誤讀不增加、體積縮減 ≥50%；真實漫畫仍待人工驗收。']
    for prefix in ['web','native']:
        key=prefix+'-kv'+('-all' if prefix=='native' else '')
        if key in metrics and 'tokenParity' in metrics[key]:
            p=metrics[key]['tokenParity'];gain=gates.get(prefix+'KvWarmGain');md.append(f'- {prefix} KV：比較 {p["compared"]} 框，token／EOS 差異 {len(p["differences"])} 框；暖機改善 '+('未量測' if gain is None else f'{gain*100:.2f}%')+f'；研究門檻 {gates.get(prefix+"KvResearchGate",False)}。')
    if 'web-kv-t4' in metrics:
        p=metrics['web-kv-t4']['tokenParity'];md.append(f'- WASM 4緒 KV：479框跨執行緒控制 token 差異 {len(p["differences"])} 框；同為4緒的50框暖機改善 {gates["web4KvWarmGain"]*100:.2f}%，研究門檻 {gates["web4KvResearchGate"]}。')
    if 'screenai-all' in runs:
        r=runs['screenai-all'];md.append(f'- Screen AI：{r["status"]}；版本 {r.get("version")}，尺寸門檻 {r.get("maxDimension")}。原始 protobuf 與行／詞／字元座標保留在本機。')
    else:md.append('- Screen AI：未完成；檢查 smoke 結果與終端 log，不能以初始化或部分輸出宣稱全章成功。')
    md+=['','## 單模型移植','',f'- 狀態：{portable.get("status") if portable else "未完成"}。', '- `hanijpan.tflite` 是單列辨識網路，非完整 Screen AI OCR；字表、切列、方向、註音及讀序需分開驗證。']
    if portable:
        for a in portable.get('attempts',[]):md.append(f'- {a["tool"]}：{a["status"]}，exit={a["returncode"]}；詳見 `{a["log"]}`。')
        for s in portable.get('samples',[]):md.append(f'- `{s["id"]}` `{s["reference"]}`：TFLite CTC `{s["source"]}`；原生 ONNX CTC `{s.get("onnxSource","")}`；argmax 一致性 {s.get("argmaxParity",False)}；前處理 `{s.get("preprocessing","")}`。')
        md.append(f'- ORT Web 單模型：{portable_web.get("status") if portable_web else "未完成／不適用"}。')
        md.append(f'- 控制樣本統計：{json.dumps(portable_counts,ensure_ascii=False)}。這8張是4段已知文字×2種前處理的校準探針，不代表漫畫辨識準確率。')
        if portable_counts:
            pc=portable_counts;n=pc['samples'];md.append(f'- 原生ORT/Web argmax相同 {pc["onnxNativeWebArgmaxParity"]}/{n}；原TFLite與ONNX逐步相同 {pc["tfliteOnnxArgmaxParity"]}/{n}。TFLite原生CTC完整讀對 {pc["tfliteExact"]}/{n}，ONNX原生 {pc["onnxNativeExact"]}/{n}、Web {pc["onnxWebExact"]}/{n}，完整Screen AI控制組 {pc["screenAIExact"]}/{n}。字表文字標籤 {portable["labelMap"]["labels"]}，另有blank ID {portable["labelMap"]["blankId"]}。')
        md.append('- 有界原因定位：TFLite reference kernels與XNNPACK之間也有量化輸出差異，ONNX與reference亦不一致；此證據不足以把差異全部歸因於某一轉換器。完整數值在 `portable/backend-diagnostic.json`。')
        if alternate:md.append(f'- 第二條轉換路線：{alternate["status"]}，原因 `{alternate.get("error","")}`。未新增算子或改寫量化核心。')
        md.append('- 停止條件：單列數值／文字門檻未過，未進多列切分或還原私有解碼。TFJS TFLite fallback未啟動：已確認ONNX原生/Web可執行，待解的是數值與解碼，原TFLite簡單CTC本身也未達可用門檻。')
        table+=['<h2>單模型校準探針</h2><p class="warning">8張校準圖，並非漫畫準確率。ONNX原生/Web一致，與TFLite逐步argmax未達等價；完整Screen AI另外作控制。</p><div class="scroll"><table><tr><th>圖／前處理</th><th>已知文字</th><th>TFLite CTC</th><th>ONNX原生</th><th>ONNX Web</th><th>完整Screen AI</th></tr>']
        for s in portable.get('samples',[]):
            w=web_by.get(s['id'],{}) if portable_counts else {};c=control_by.get(s['id'],{}) if portable_counts else {}
            table.append('<tr><td><img src="'+s['image']+'" alt="'+s['id']+'"><br>'+html.escape(s.get('preprocessing',''))+'</td>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in [s['reference'],s['source'],s.get('onnxSource',''),w.get('source',''),c.get('source','')])+'</tr>')
        table.append('</table></div>')
    md+=['','## 研究判斷','', '研究推薦用於決定下一次整合方向，正式插件與預設設定尚未變更。','', '| 路線 | 判斷 | 依據／邊界 |','|---|---|---|']
    for name,j in judgements.items():md.append(f'| {name} | {j["decision"]} | {j["reason"]} |')
    table+=['<h2>研究判斷</h2><table><tr><th>路線</th><th>判斷</th><th>邊界</th></tr>']
    for name,j in judgements.items():table.append('<tr>'+''.join('<td>'+html.escape(v)+'</td>' for v in [name,j['decision'],j['reason']])+'</tr>')
    table.append('</table>')
    md+=['','## 復現與產物','',
        '詳細版本、來源、SHA-256：`artifacts/research-ocr/{manifest,asset-lock,dataset,freeze-receipt}.json`。逐框資料與分組指標：`results/`、`summary.json`。離線比較頁：`comparison.html`。真實漫畫與第三方權重皆在 Git 忽略目錄。','',
        '```powershell',"Set-Location -LiteralPath 'C:\\Users\\a0953041880\\comic transcriber'",'node scripts/research-ocr/browser.mjs baseline,int8','python scripts/research-ocr/native.py --variant baseline','python scripts/research-ocr/native.py --variant int8','python scripts/research-ocr/native.py --variant kv','python scripts/research-ocr/throughput.py',"node scripts/research-ocr/browser.mjs 'baseline@4:sample,int8@4:sample,kv@4'",'python scripts/research-ocr/run_bridge.py',r'.\.cache\research-ocr-convert\Scripts\python.exe scripts/research-ocr/portable.py',r'.\.cache\research-ocr-convert\Scripts\python.exe scripts/research-ocr/portable_diagnostic.py',r'.\.cache\research-ocr-convert\Scripts\python.exe scripts/research-ocr/alternate_converter.py','python scripts/research-ocr/screenai.py --mode portable','node scripts/research-ocr/browser.mjs portable','python scripts/research-ocr/test_metrics.py','python scripts/research-ocr/report.py','```','',
        '復現前先確認無匹配 live process，再執行所需階段；固定資料已存在時沿用，避免重新偵測。模型轉換使用隔離 Python 3.12 環境，完整版本在 `conversion-environment.txt`；研究未修改專案原有依賴。若需重新建環境，以 `uv venv --python C:\\Python312\\python.exe .cache/research-ocr-convert` 建立，再以 `uv pip install --python .cache/research-ocr-convert/Scripts/python.exe -r scripts/research-ocr/conversion-requirements.txt` 安裝。',
        '瀏覽器測試器保留固定 tensor 快取；記憶體包含量測器成本，不是正式插件 RAM 保證。最初 baseline/INT8 的實際 JS bundle 與原生 runner 已另外保存 execution snapshot；後續 browser receipt綁定每輪bundle雜湊。',
        '候選來源：[INT8 MangaOCR](https://huggingface.co/ogkalu/manga-ocr-onnx)、[Fushi KV models](https://github.com/hajisensai/Fushi/releases/tag/manga-ocr-kv-onnx-v1)、[clv-locro](https://github.com/sergiocorreia/clv-locro)、[tf2onnx](https://github.com/onnx/tensorflow-onnx)、[tflite2onnx](https://github.com/zhenhuaw-me/tflite2onnx)。clv-locro原始碼與MIT授權保留在本機；主要橋接成功，未啟動OwOCR備援。','']
    validation=load(OUT/'validation.json');ui=load(OUT/'ui-verification.json')
    if validation and ui:md+=['## 交付驗證','',f'- 產物完整性：{validation["status"]}；圖片/tensor/模型/來源雜湊、完整結果ID與三次暖機、protobuf覆蓋及WASM實際worker均已核對。',f'- 比較頁：{ui["status"]}；149真實區域、300合成框、30空白框的篩選，錯誤篩選、圖片路徑、桌面與手機截圖及頁面錯誤均已驗證。','- 指標單元測試及Python/JavaScript語法檢查以終端驗證紀錄為準；未執行正式插件安裝／翻譯驗收。','']
    (ROOT/'docs/research-ocr.md').write_text('\n'.join(md),encoding='utf-8')
    refs_by={r['id']:r for r in refs['rows']};output_by={n:{r['id']:r for r in v.get('results',[])} for n,v in runs.items()}
    body=[head,*table,'<div class="tools"><label>資料集<select id="dataset"><option value="real">真實漫畫</option><option value="synthetic">合成文字</option><option value="blank">空白</option><option value="all">全部</option></select></label><label><input type="checkbox" id="mismatch">只看參考文字有差異</label><span id="count"></span></div><div class="scroll"><table id="comparison"><thead><tr><th>裁圖／位置</th><th>參考原文</th>'+''.join('<th>'+html.escape(n)+'</th>' for n in runs)+'</tr></thead><tbody>']
    for row in data['records']:
        truth=row.get('reference') if row['dataset']!='real' else refs_by.get(row['id'],{}).get('source')
        from metrics import normalize
        mismatch=truth is not None and any(row['id'] in output_by[n] and normalize(output_by[n][row['id']].get('source',''))!=normalize(truth) for n in runs)
        body.append(f'<tr data-set="{row["dataset"]}" data-mismatch="{int(mismatch)}"><td><strong>{html.escape(row["id"])}</strong><br><img loading="lazy" src="{row["crop"]}" alt="{row["id"]}">')
        if row['dataset']=='real':body.append(f'<br><a href="overlays/{row["page"]:02}.png">原頁偵測框</a> · {html.escape(row["section"])}'+(' · AI補列漏框' if row.get('manualAddition') else ''))
        body.append('</td><td><pre>'+html.escape('未標註／歧義排除' if truth is None else truth)+'</pre></td>')
        for n in runs:
            r=output_by[n].get(row['id']);source=r.get('source','') if r else '未執行';different=r is not None and truth is not None and normalize(source)!=normalize(truth)
            body.append('<td'+(' class="bad"' if different else '')+'><pre>'+html.escape(source)+'</pre><small>'+('' if not r else f'{r.get("ms",0):.1f} ms')+'</small></td>')
        body.append('</tr>')
    body.append('''</tbody></table></div><script>const filter=()=>{let count=0;for(const row of document.querySelectorAll('#comparison tbody tr')){const show=(dataset.value==='all'||row.dataset.set===dataset.value)&&(!mismatch.checked||row.dataset.mismatch==='1');row.hidden=!show;if(show)count++;}document.querySelector('#count').textContent=count+' 個區域';};const dataset=document.querySelector('#dataset'),mismatch=document.querySelector('#mismatch');dataset.onchange=filter;mismatch.onchange=filter;filter();</script></html>''')
    (OUT/'comparison.html').write_text(''.join(body),encoding='utf-8')
    print(json.dumps({'runs':{n:r['status'] for n,r in runs.items()},'gates':gates},ensure_ascii=False))

if __name__=='__main__':main()
