# 漫畫 OCR 優化研究：Tensei Goblin 第 24 話

結果時間（UTC）：2026-10-28T15:12:47Z。研究使用全章 17 頁，沒有執行翻譯、改動正式插件或反編譯 DLL。

## 證據與限制

- 主素材：使用者提供的 ZIP；146 個 RT-DETR 區域，加上局部視覺審查補列的 3 個擬聲詞漏框。未建立全章人工框標註，因此不報完整偵測召回率。
- 50 個代表框參考稿在 OCR 前凍結；47 框可計分，3 框歧義排除。參考稿是 AI 視覺轉錄，包含尚待人工核對的標點、小字與讀序，所得 CER 僅為診斷。
- 輔助集為 30 頁／300 個已知原文合成框，加 30 個空白區。合成品質不代表真實漫畫品質。
- MangaOCR native/web 共用固定 Pillow 灰階、BILINEAR 224×224、float32 [-1,1] tensor；隔離模型/runtime 差異，未涵蓋正式插件 Canvas 前處理驗收。
- 空白略過沿用現有 MangaOCR 判斷；Screen AI 直接讀原始裁圖。空白誤讀反映各候選流程，並非純網路單獨比較。
- 全資料首輪一次，50 框暖機三次。首輪包含按需 tensor 讀取；暖機、模型初始化及實際後端分開保存。
- 讀序錯誤保留逐框 unknown／待視覺覆核，尚未建立可靠的自動分類；CER 包含讀序造成的編輯差異。重複字欄僅抓連續 16 個同字；截斷欄反映解碼長度上限，沒有此訊號的引擎標為 unknown。
- Native ORT 使用 CPUExecutionProvider、intra/inter=1；Screen AI 內部執行緒由引擎管理，跨引擎耗時包含這項差異。
- Windows Working Set／Private Commit 各別記錄；瀏覽器逐程序 lifetime peak 不相加作同時總峰值，JS heap 不代表 WASM 或整個瀏覽器 RAM。

## 執行結果

| 執行組 | 狀態 | 完成框數 | 合成 CER | 漫畫 AI 參考 CER | 空白誤讀 | 暖機 50 框中位 |
|---|---|---:|---:|---:|---:|---:|
| web-baseline | complete | 479/479 | 0.00% | 25.96% | 0 | 67.060 s |
| web-int8 | complete | 479/479 | 0.00% | 26.14% | 0 | 40.224 s |
| native-baseline-all | complete | 479/479 | 0.00% | 25.96% | 0 | 26.095 s |
| native-int8-all | complete | 479/479 | 0.00% | 26.14% | 0 | 8.946 s |
| native-kv-all | complete | 479/479 | 0.00% | 25.96% | 0 | 19.300 s |
| web-baseline-t4-sample | complete | 50/50 | — | 25.96% | — | 24.577 s |
| web-int8-t4-sample | complete | 50/50 | — | 26.14% | — | 14.666 s |
| web-kv-t4 | complete | 479/479 | 0.00% | 25.96% | 0 | 18.279 s |
| screenai-all | complete | 479/479 | 9.18% | 34.00% | 0 | 4.599 s |

## 宣傳頁、扉頁與正文

宣傳頁與扉頁已全框推論，本輪凍結的 47 個可計分 AI 參考框均在正文；前兩頁成績以未評分表示，避免當作零錯誤。

| 執行組 | 頁面組別 | 框數 | AI參考可計分框 | CER | 整框正確率 |
|---|---|---:|---:|---:|---:|
| web-baseline | 宣傳頁 1 | 16 | 0 | — | — |
| web-baseline | 扉頁 2 | 2 | 0 | — | — |
| web-baseline | 正文 3–17 | 131 | 47 | 25.96% | 63.83% |
| web-int8 | 宣傳頁 1 | 16 | 0 | — | — |
| web-int8 | 扉頁 2 | 2 | 0 | — | — |
| web-int8 | 正文 3–17 | 131 | 47 | 26.14% | 63.83% |
| native-kv-all | 宣傳頁 1 | 16 | 0 | — | — |
| native-kv-all | 扉頁 2 | 2 | 0 | — | — |
| native-kv-all | 正文 3–17 | 131 | 47 | 25.96% | 63.83% |
| screenai-all | 宣傳頁 1 | 16 | 0 | — | — |
| screenai-all | 扉頁 2 | 2 | 0 | — | — |
| screenai-all | 正文 3–17 | 131 | 47 | 34.00% | 38.30% |

## CPU 多執行緒與併發

使用者追加授權後，以 6 核／12 緒 i5-12400 量測。每個 ORT session 的 intra=4、inter=1；此設定不是整個 worker 的全域執行緒上限。CPU 欄為推論程序 CPU time 折算 12 個邏輯核心的比例，可能包含 runtime 執行緒池的等待工作。不同配置分開計時，未與其他模型計時互相干擾。

| 模型 | workers | 每 session intra | 50 框中位 | CPU 比例 | token 差異 |
|---|---:|---:|---:|---:|---:|
| baseline | 1 | 4 | 11.695 s | 57.7% | 0 |
| baseline | 2 | 4 | 12.873 s | 94.0% | 0 |
| int8 | 1 | 4 | 4.245 s | 58.0% | 0 |
| int8 | 2 | 4 | 4.184 s | 94.4% | 0 |
| kv | 1 | 4 | 9.367 s | 82.3% | 0 |
| kv | 2 | 4 | 16.238 s | 93.3% | 0 |

本輪以單 worker／每 session 4 緒作為較穩定的原生配置候選。雙 worker 的 INT8 改善很小，baseline 與 KV 反而較慢；不因 CPU 使用率較高就建議提高併發。


## 階段判定

- INT8 檔案：111.37 MiB；全精度模型與字表：439.61 MiB；縮減 74.67%。
- INT8 研究門檻：True。門檻是合成 CER 增幅 ≤0.5 個百分點、空白誤讀不增加、體積縮減 ≥50%；真實漫畫仍待人工驗收。
- native KV：比較 479 框，token／EOS 差異 0 框；暖機改善 26.04%；研究門檻 True。
- WASM 4緒 KV：479框跨執行緒控制 token 差異 0 框；同為4緒的50框暖機改善 25.63%，研究門檻 True。
- Screen AI：complete；版本 [153, 4]，尺寸門檻 2048。原始 protobuf 與行／詞／字元座標保留在本機。

## 單模型移植

- 狀態：native-probe-complete。
- `hanijpan.tflite` 是單列辨識網路，非完整 Screen AI OCR；字表、切列、方向、註音及讀序需分開驗證。
- tf2onnx：converted-and-native-ORT-loadable，exit=0；詳見 `portable/tf2onnx.log`。
- `portable-0` `今日は晴れ`：TFLite CTC `今日は晴れ 0`；原生 ONNX CTC `今日は晴れ`；argmax 一致性 False；前處理 `fixed font24 on 168x32 white canvas`。
- `portable-1` `ありがとう`：TFLite CTC `ありがとう 1`；原生 ONNX CTC `ありがとう う`；argmax 一致性 False；前處理 `fixed font24 on 168x32 white canvas`。
- `portable-2` `何を作った`：TFLite CTC `何を作った O`；原生 ONNX CTC `何を作った O`；argmax 一致性 True；前處理 `fixed font24 on 168x32 white canvas`。
- `portable-3` `肉じゃが`：TFLite CTC `囱じゃが う`；原生 ONNX CTC `抜じゃが 0`；argmax 一致性 False；前處理 `fixed font24 on 168x32 white canvas`。
- `portable-4` `今日は晴れ`：TFLite CTC `今日は晴れ り`；原生 ONNX CTC `今日は晴れ し`；argmax 一致性 False；前處理 `tight black-ink bounds stretched to 168x32`。
- `portable-5` `ありがとう`：TFLite CTC `ありがとう`；原生 ONNX CTC `ありがとう`；argmax 一致性 False；前處理 `tight black-ink bounds stretched to 168x32`。
- `portable-6` `何を作った`：TFLite CTC `何を作った`；原生 ONNX CTC `の何を作った`；argmax 一致性 False；前處理 `tight black-ink bounds stretched to 168x32`。
- `portable-7` `肉じゃが`：TFLite CTC `| 肉じゃが`；原生 ONNX CTC `肉じゃが`；argmax 一致性 False；前處理 `tight black-ink bounds stretched to 168x32`。
- ORT Web 單模型：complete。
- 控制樣本統計：{"samples": 8, "tfliteExact": 2, "onnxNativeExact": 3, "onnxWebExact": 3, "screenAIExact": 7, "tfliteOnnxArgmaxParity": 1, "onnxNativeWebArgmaxParity": 8}。這8張是4段已知文字×2種前處理的校準探針，不代表漫畫辨識準確率。
- 原生ORT/Web argmax相同 8/8；原TFLite與ONNX逐步相同 1/8。TFLite原生CTC完整讀對 2/8，ONNX原生 3/8、Web 3/8，完整Screen AI控制組 7/8。字表文字標籤 8178，另有blank ID 8178。
- 有界原因定位：TFLite reference kernels與XNNPACK之間也有量化輸出差異，ONNX與reference亦不一致；此證據不足以把差異全部歸因於某一轉換器。完整數值在 `portable/backend-diagnostic.json`。
- 第二條轉換路線：conversion-failed，原因 `AssertionError('Per-tensor support only currently')`。未新增算子或改寫量化核心。
- 停止條件：單列數值／文字門檻未過，未進多列切分或還原私有解碼。TFJS TFLite fallback未啟動：已確認ONNX原生/Web可執行，待解的是數值與解碼，原TFLite簡單CTC本身也未達可用門檻。

## 研究判斷

研究推薦用於決定下一次整合方向，正式插件與預設設定尚未變更。

| 路線 | 判斷 | 依據／邊界 |
|---|---|---|
| INT8 MangaOCR | 建議採用為下一版優先整合候選 | 體積及合成集門檻分開驗證；真實漫畫仍待人工確認。 |
| KV-cache | 建議採用為全精度加速候選 | 全精度保真加速路線；本輪未與 INT8 合併。 |
| Screen AI bridge | 保留候選，暫不取代 MangaOCR | 現成橋接與直排座標已實跑；直接串接文字列的合成 CER 落後，仍需處理雜字、標點、註音及讀序。 |
| Screen AI recognizer ONNX | 停止本輪完整移植投入，保留單模型成果 | 計算圖能在原生/Web運算，量化張量與CTC文字等價性未過；另一轉換器不支援per-channel量化。 |
| CPU scheduling | 建議單 worker、每 ORT session intra=4 作為原生配置候選 | 雙 worker 雖使 CPU 時間折算比例達約94%，本批 baseline/KV 較慢，INT8 改善很小。 |

## 復現與產物

詳細版本、來源、SHA-256：`artifacts/research-ocr/{manifest,asset-lock,dataset,freeze-receipt}.json`。逐框資料與分組指標：`results/`、`summary.json`。離線比較頁：`comparison.html`。真實漫畫與第三方權重皆在 Git 忽略目錄。

```powershell
Set-Location -LiteralPath 'C:\Users\a0953041880\comic transcriber'
node scripts/research-ocr/browser.mjs baseline,int8
python scripts/research-ocr/native.py --variant baseline
python scripts/research-ocr/native.py --variant int8
python scripts/research-ocr/native.py --variant kv
python scripts/research-ocr/throughput.py
node scripts/research-ocr/browser.mjs 'baseline@4:sample,int8@4:sample,kv@4'
python scripts/research-ocr/run_bridge.py
.\.cache\research-ocr-convert\Scripts\python.exe scripts/research-ocr/portable.py
.\.cache\research-ocr-convert\Scripts\python.exe scripts/research-ocr/portable_diagnostic.py
.\.cache\research-ocr-convert\Scripts\python.exe scripts/research-ocr/alternate_converter.py
python scripts/research-ocr/screenai.py --mode portable
node scripts/research-ocr/browser.mjs portable
python scripts/research-ocr/test_metrics.py
python scripts/research-ocr/report.py
```

復現前先確認無匹配 live process，再執行所需階段；固定資料已存在時沿用，避免重新偵測。模型轉換使用隔離 Python 3.12 環境，完整版本在 `conversion-environment.txt`；研究未修改專案原有依賴。若需重新建環境，以 `uv venv --python C:\Python312\python.exe .cache/research-ocr-convert` 建立，再以 `uv pip install --python .cache/research-ocr-convert/Scripts/python.exe -r scripts/research-ocr/conversion-requirements.txt` 安裝。
瀏覽器測試器保留固定 tensor 快取；記憶體包含量測器成本，不是正式插件 RAM 保證。最初 baseline/INT8 的實際 JS bundle 與原生 runner 已另外保存 execution snapshot；後續 browser receipt綁定每輪bundle雜湊。
候選來源：[INT8 MangaOCR](https://huggingface.co/ogkalu/manga-ocr-onnx)、[Fushi KV models](https://github.com/hajisensai/Fushi/releases/tag/manga-ocr-kv-onnx-v1)、[clv-locro](https://github.com/sergiocorreia/clv-locro)、[tf2onnx](https://github.com/onnx/tensorflow-onnx)、[tflite2onnx](https://github.com/zhenhuaw-me/tflite2onnx)。clv-locro原始碼與MIT授權保留在本機；主要橋接成功，未啟動OwOCR備援。

## 交付驗證

- 產物完整性：passed；圖片/tensor/模型/來源雜湊、完整結果ID與三次暖機、protobuf覆蓋及WASM實際worker均已核對。
- 比較頁：passed；149真實區域、300合成框、30空白框的篩選，錯誤篩選、圖片路徑、桌面與手機截圖及頁面錯誤均已驗證。
- 指標單元測試及Python/JavaScript語法檢查以終端驗證紀錄為準；未執行正式插件安裝／翻譯驗收。
