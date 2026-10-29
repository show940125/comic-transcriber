"""Combine the implementation evidence without merging research and live acceptance."""
import html,json,statistics,time
from pathlib import Path
from prepare import ROOT,OUT,save,sha
def read(name,default=None):
    path=OUT/name
    return json.loads(path.read_text('utf-8')) if path.exists() else default
def pct(x):return '—' if x is None else f'{x*100:.2f}%'
def main():
    adoption=read('combo/adoption.json');data=read('dataset.json');refs=read('references.json');reference={r['id']:r['source'] for r in refs['rows']}
    names=['baseline','int8','kv','hybrid','qint8'];labels={'baseline':'全精度一般','int8':'INT8 一般（預設）','kv':'全精度 KV（可選）','hybrid':'INT8 encoder＋浮點 KV','qint8':'INT8 encoder＋QInt8 KV'}
    runs={name:read(f'results/web-{name}-t4-canvas.json') for name in names};by={n:{r['id']:r for r in v['results']} for n,v in runs.items()}
    extension={p.stem:json.loads(p.read_text('utf-8')) for p in (OUT/'combo').glob('extension-*-t*.json') if '-ui' not in p.stem}
    ui={p.stem:json.loads(p.read_text('utf-8')) for p in (OUT/'combo').glob('extension-*-t*-ui.json')}
    final_ui={name:r for name,r in extension.items() if name.endswith('-final')}
    if final_ui:ui=final_ui
    deliveryPath=ROOT/'artifacts/zip-verification.json';delivery=json.loads(deliveryPath.read_text()) if deliveryPath.exists() else None
    if delivery and delivery.get('version')!='0.1.16':delivery=None
    preflight=read('live-chrome/preflight.json');live=read('live-chrome/acceptance.json')
    report={'status':'local-validation-in-progress' if any(r['status']!='passed' for r in extension.values()) or len(extension)<4 else 'isolated-validation-complete','createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'adoption':adoption['gates'],'extension':extension,'ui':ui,'delivery':delivery,'liveChrome':live,'preflight':preflight,'humanGold':False}
    save('combo/implementation-summary.json',report)
    md=['# OCR 優化實裝與驗收｜0.1.16','',f'更新時間（UTC）：{report["createdAt"]}。本機候選；公開發布另行處理。','',
        '## 採用結果','',
        '預設採 INT8 MangaOCR 一般解碼＋WASM 自動多緒；全精度模式採 KV，按需要另行下載。固定 50 框、同為 WASM 4 緒的獨立三次暖機如下。全章準確率首輪與暖機效能分開保存。','',
        '| 模型 | 50框中位 | 合成CER | 漫畫AI參考CER | 主要renderer峰值 |','|---|---:|---:|---:|---:|']
    perf=[]
    for name in names:
        trial=adoption['trials'][name];g=adoption['metrics'][name]['groups'];values=[labels[name],f'{trial["median50Ms"]/1000:.3f}s',pct(g['synthetic']['cer']),pct(g['real']['cer']),f'{trial["rendererPeakWorkingSetBytes"]/1048576:.1f}MiB'];md.append('| '+' | '.join(values)+' |');perf.append(values)
    gates=adoption['gates'];md+=['',f'- INT8 權重含字表 {adoption["bytes"]["int8"]/1048576:.2f} MiB，全精度一般模式 {adoption["bytes"]["fp32"]/1048576:.2f} MiB，縮減 {gates["int8SizeReduction"]*100:.2f}%。',f'- 全精度 KV：479框逐步 token／EOS 零差異，固定50框暖機縮短 {gates["fp32KvSpeedGain"]*100:.2f}%。',f'- INT8＋浮點KV相對INT8一般模式耗時增加 {-gates["hybrid"]["speedGainVsInt8"]*100:.2f}%；QInt8 KV增加 {-gates["qint8"]["speedGainVsInt8"]*100:.2f}%，均未達至少15%加速門檻，維持研究候選。',
      '- 五組都完成479框；相同CER不代表逐框相同，所有差異保留。真實漫畫47個可計分參考為AI視覺覆核，待人工確認；宣傳頁及扉頁未建立參考，讀序仍待獨立覆核。',
      '- 記憶體為隔離測試主要renderer的lifetime Working Set峰值，包含量測器；不同程序峰值不相加，也不作正式插件RAM保證。','',
      '## 使用行為','',
      '- 模式分別下載；切換profile／provider先釋放舊OCR sessions，KV只活在單一框。auto依CPU邏輯緒數的一半、最多4緒；隔離/SAB不成立或初始化失敗明確回退單緒。',
      '- 工作台可看原裁圖、單框重辨、切換模式比較，最多兩份候選，選擇套用後才變更原文；變更只清除該框譯文及章節校正指紋。支援畫線拆框、預覽、套用與撤銷。',
      '- 偵測分數與OCR信心分開，缺值顯示未提供。模型／前處理加入快取身分；legacy須明確載入，保留舊身分至新OCR被採用。schema1候選白名單、私人Reader與網站工作台隔離。','',
      '## 隔離擴充功能驗收','', '| 執行組 | 狀態 | profile／框數 | 執行緒及資源 |','|---|---|---|---|']
    for name,result in extension.items():
        coverage='、'.join(f'{r["profile"]} {len(r["results"])}框' for r in result['runs']);runtime='、'.join(f'{r["profile"]}: {r.get("runtime",{}).get("effectiveThreads","待完成")}緒' for r in result['runs']);md.append(f'| {name} | {result["status"]} | {coverage} | {runtime} |')
    for name,r in ui.items():md.append(f'- {name}：{r["status"]}；閒置釋放實測 {r.get("idleElapsedMs",0)/1000:.2f}秒。')
    md+=['','隔離測試採Chrome for Testing（Playwright Chromium）及Edge；現場使用者Chrome另列。完整矩陣後新增暖機取消訊息檢查點，標記final的兩組是最後建置的固定50框回歸，並檢查progress同步取消、恢復與legacy新快取隔離。原始失敗收據保留，未拿後續成功覆寫診斷。','',
         '暖機取消的原因是連續WASM解碼可能只排入微任務，使Worker取消訊息不能及時執行。現在每8步以MessageChannel交回訊息佇列；新增回歸測試及兩瀏覽器實際Worker驗證。載入提示也分為準備、實際下載與初始化。','',
         '## 五項後續研究結論','',
         '| 方向 | 結論與證據 |','|---|---|',
         '| 裁切留白／切列／註音分離 | 479框獨立對照；合成CER由0變為0／26.30%／0.758%，AI漫畫26.14%變為33.27%／38.94%／26.14%。停止自動採用，保留手動拆框。 |',
         '| Screen AI幾何讀序 | 合成CER9.18%→7.67%，AI漫畫34.00%→34.19%；35框讀序變化、38個越界字元座標。保留研究，尚未加入自動讀序。 |',
         '| 原生隔離與資源管理 | 同PID三次、EOF、閒置退出及注入故障的獨立子程序測試通過；故障與空結果分開。測試閒置1秒，正式插件60秒另測。 |',
         '| Tank-OCR Go FFI | 固定commit 3f9fbacad3e0ee357ff19bf334375524c292d13e，隔離可攜Go編譯後連續呼叫本機153.4成功。保留免Python候選，沒有正式服務／安裝器交付。 |',
         '| 固定日文依賴精簡 | 完整初始化成功、追蹤35個檔案；限制其他語系檔案後初始化false。停止本輪精簡。 |',
         '', 'hanijpan完整移植仍維持停止投入；未反編譯DLL、未開發私有算子。原始結果及來源快照留在本機。','',
         '## 現場Chrome與交付','']
    if live:
        md+=['現場驗收狀態：'+str(live.get('status'))+'；指定GPT-6.1 Terra、medium子智慧體在使用者已開啟的Chrome Rawkuma分頁操作，其他插件保持原狀。版本與修正版重載由使用者確認，未繞過browser-use政策去讀管理頁。',
             '', '已觀察INT8/standard/wasm、候選保留及套用、拆框撤銷、Google單張文字翻譯、套用、重開保留與原圖切換。修正版也已重開及重辨。',
             '', '限制：一框預設擦字仍有日文殘留；手動白底可消除重疊但遮到對話框邊線。現場取消按鈕因OCR已完成而脫離DOM，取消效果未觀察；不能拿自動化點擊錯誤判定產品取消失效。單張整體重辨沿用原流程，會清除該張譯文及先前候選；新增單框比較可先保留原文。相鄰圖片可見，動態懶載入與其他插件的全面相容性仍未獨立證明。',
             '', '完整操作與截圖：本機 `live-chrome/acceptance.md`、`acceptance.json`。']
    else:md.append('現場驗收：待完成。已找到指定Rawkuma分頁與FullPictureLoad工具列；Chrome管理頁被browser-use政策拒絕，需要使用者手動重載／啟用後，由指定Terra 6.1 medium子智慧體在HTTP漫畫頁面驗收。')
    if delivery:md+=['',f'本機ZIP：`{delivery["path"]}`，{delivery["bytes"]:,}bytes，SHA-256 `{delivery["sha256"]}`；CRC、manifest與逐檔核對{delivery["status"]}。']
    else:md.append('本機0.1.16 ZIP核對尚未完成。')
    md+=['','## 完整性驗證','', '146項測試通過，型別／建置／離線權重白名單通過；最後建置在兩瀏覽器通過暖機取消、恢復、legacy分離保存及60秒閒置。完整來源、執行副本、逐框ID、QA與ZIP雜湊由 `implementation-manifest.json` 綁定；現場Chrome的partial狀態保留。','','來源與復現：`combo/adoption.json`、`combo/implementation-summary.json`、完整Canvas及sample結果／receipt、各研究probe腳本。程式及權重固定身分以manifest與交付收據為準；漫畫、Screen AI元件與外部研究程式碼不進Git或插件ZIP；預設INT8與偵測器權重隨離線套件提供。']
    (ROOT/'docs/ocr-optimization.md').write_text('\n'.join(md)+'\n',encoding='utf-8')
    esc=lambda v:html.escape(str(v));body=['<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>墨譯0.1.16 OCR優化驗收</title><style>body{font:16px system-ui;background:#f5f3ed;color:#253b30;margin:auto;max-width:1700px;padding:24px}h1{font-size:28px}table{border-collapse:collapse;background:white}td,th{border:1px solid #ccd3c9;padding:10px;vertical-align:top;text-align:left}pre{white-space:pre-wrap;word-break:break-word;font:15px system-ui;margin:0}.scroll{overflow:auto}#comparison td,#comparison th{min-width:170px}img{max-width:200px;max-height:300px;object-fit:contain}.warning{background:#fff0bf;padding:16px}select,input{font:inherit;padding:8px;margin:8px}.tools{position:sticky;top:0;background:#f5f3ed;padding:8px}small{display:block;color:#596e5f}.bad{background:#ffe9df}</style><h1>墨譯 0.1.16 · OCR優化與驗收</h1><p class="warning">預設INT8一般解碼＋自動多緒；全精度KV另行下載。真實漫畫參考稿為AI覆核、待人工確認。現場Chrome驗收與隔離測試分開記錄。</p><div class="scroll"><table><tr><th>模型</th><th>50框中位</th><th>合成CER</th><th>漫畫AI參考CER</th><th>renderer峰值</th></tr>']
    for row in perf:body.append('<tr>'+''.join('<td>'+esc(v)+'</td>' for v in row)+'</tr>')
    body+=['</table></div><p>量化KV組合未達15%加速門檻。全精度KV 479框token／EOS一致，暖機縮短34.69%。記憶體為單一renderer的測試峰值。</p><h2>驗收狀態</h2><ul>']
    for name,r in extension.items():body.append('<li>'+esc(name)+'：'+esc(r['status'])+'</li>')
    body+=['<li>現場使用者Chrome：'+esc(live.get('status') if live else '待使用者重載及網頁實測')+'</li></ul><div class="tools"><label>資料集<select id="dataset"><option value="real">真實漫畫</option><option value="synthetic">合成已知文字</option><option value="blank">空白</option><option value="all">全部</option></select></label><label><input type="checkbox" id="mismatch">只看模型文字不同</label><span id="count"></span></div><div class="scroll"><table id="comparison"><thead><tr><th>原裁圖／頁面</th><th>參考文字</th>'+''.join('<th>'+esc(labels[n])+'</th>' for n in names)+'</tr></thead><tbody>']
    for row in data['records']:
        rid=row['id'];truth=reference.get(rid) if row['dataset']=='real' else row.get('reference');different=any(by[n][rid]['source']!=by['baseline'][rid]['source'] for n in names)
        body.append(f'<tr data-set="{row["dataset"]}" data-mismatch="{int(different)}"><td><strong>{esc(rid)}</strong><br><img loading="lazy" src="{esc(row["crop"])}" alt="{esc(rid)}"><small>{esc(row.get("section",row.get("category","")))}</small>{("<a href=\"overlays/"+str(row["page"]).zfill(2)+".png\">原頁偵測框</a>") if row["dataset"]=="real" else ""}</td><td><pre>{esc(truth if truth is not None else "未標註／歧義排除")}</pre></td>')
        for n in names:body.append('<td'+(' class="bad"' if by[n][rid]['source']!=by['baseline'][rid]['source'] else '')+'><pre>'+esc(by[n][rid]['source'])+'</pre></td>')
        body.append('</tr>')
    body.append('''</tbody></table></div><script>const dataset=document.querySelector('#dataset'),mismatch=document.querySelector('#mismatch');function filter(){let count=0;for(const row of document.querySelectorAll('#comparison tbody tr')){row.hidden=!(dataset.value==='all'||row.dataset.set===dataset.value)||mismatch.checked&&row.dataset.mismatch!=='1';if(!row.hidden)count++;}document.querySelector('#count').textContent=count+' 個區域';}dataset.onchange=filter;mismatch.onchange=filter;filter();</script></html>''')
    (OUT/'optimization.html').write_text(''.join(body),encoding='utf-8');print('Optimization report updated; isolated/live acceptance remain separate.')
if __name__=='__main__':main()
