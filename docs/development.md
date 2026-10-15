# 開發與模型部署

## 建置環境

瀏覽器擴充套件使用 Node.js 24、npm 與 Chrome／Edge。Python 工具以 3.14 開發；OCR 本機服務依賴 ONNX Runtime、NumPy 與 Pillow，版本列於 `requirements.txt`。

```sh
git clone https://github.com/show940125/comic-transcriber.git
cd comic-transcriber
npm ci
npm run assets
npm run typecheck
npm test
npm run build
```

`npm run assets` 準備 ONNX Runtime WASM、WebLLM 模型執行 WASM、Noto Sans CJK TC 字型及第三方授權文件。這些執行資源會隨擴充套件打包，模型權重由固定來源下載。`src/model-lock.json` 記錄 revision、來源與 SHA-256；一般建置沿用鎖定值，重新解析上游版本需明確執行 `node scripts/prepare-assets.mjs --refresh-lock`。

## 離線建置

一般建置的 OCR 權重在瀏覽器首次使用時下載。將權重加入未封裝套件可省去首次瀏覽器下載：

```sh
python scripts/download-vision.py
node scripts/stage-vision.mjs
npm run audit:package
npm run package
python scripts/verify-delivery.py
```

這組命令接在 `npm run build` 後執行。下載程式核對權重雜湊，stage 程式將 detector 與 Manga-OCR 放入 `.output/chrome-mv3/models`；重新建置會移除 staged 權重，需再次 stage。ZIP 位於 `dist/`，完整性核對結果寫入本機 `artifacts/`。

離線 OCR 套件約 465 MiB。Google 翻譯仍需網路；完全離線翻譯需先準備 Chrome 語言包、WebLLM 權重或本機模型服務。瀏覽器快取與開發工具下載的模型各自獨立。

## 資料流

網站的 content script 收集圖片，透過 service worker 讀取已授權的圖片來源。offscreen 文件中的 Worker 執行偵測、OCR 與模型翻譯，校正介面在 Shadow DOM 中嵌字。原圖、結果圖與文字區域分開保存，快取以圖片雜湊與相關設定區隔。

| 翻譯模式 | 送出的資料 | 執行位置 |
|---|---|---|
| Google 網頁翻譯 | OCR 對白文字 | 固定 Google HTTPS 端點 |
| Chrome Translator API | 初始化時下載語言包；翻譯在本機執行 | 瀏覽器 |
| WebLLM | 初次下載模型權重；翻譯在本機執行 | WebGPU |
| 本機翻譯／OCR 服務 | 對白文字／圖片及區域資料 | 設定的 loopback 服務 |

網站與圖片 CDN 分別授權。OpenAI-compatible 與 OCR 備援端點僅接受 localhost／127.0.0.1 等 loopback 地址，備援需在設定中啟用。

### GPU 探測與字形白底

OCR 預設 WASM；由 0.1.0–0.1.8 更新時，舊設定的 `ocrProvider: auto` 改為 `wasm`。需要比較 GPU 時，可重新選 GPU 優先。工作台及設定頁開啟時不主動探測 GPU，WebLLM 或選用 WebGPU OCR 時才呼叫 adapter，結果包含不可用狀態均在 Worker 中快取。程式自身呼叫 `requestAdapter()` 時省略 Windows 不採用的 `powerPreference`；第三方執行庫與瀏覽器仍可能留下明確 GPU 操作的警告。

字形白底先辨認文字框內高對比筆畫，排除跨邊界的大型氣泡輪廓，向外擴張少量像素後，以鄰近未遮蔽像素補色。中文以 Canvas 繪出字形遮罩，擴張圓形描邊並填滿封閉空隙，再畫上不透明白底和黑字。這是 CPU 局部補色，細緻插畫上的修復仍需人工檢查；矩形浮層和手動白底保留為逐框選項。

文字框、`ocrBox` 與 `bubbleBox` 分別保存原文定位、OCR 裁切及氣泡範圍。從文字框周圍尋找連通淺底，優先使用閉合氣泡；開口氣泡補入與文字位置一致的連通筆畫孔洞。排版使用修補後的內部範圍，清除遮罩另以原文位置判斷，保護邊線及插畫。

中文比較橫／直排的可容納字級，高寬比至少 1.8 時優先由右至左直排。Region 的 `textDirection` 可選 `auto`／`horizontal`／`vertical`，`fontScale` 範圍為 0.5–2，實際字級受安全範圍限制。校正 JSON 維持 schema 1，新增欄位可省略，舊檔使用自動設定；新增幾何欄位也會核對圖片邊界。

無法辨認安全氣泡或一致背景時，顯示「原文清除需校正」。網點上的輕量補色可能留下痕跡，工作台保留人工模式。

### 章節排程與生命週期

單張工作台與整章共用 `src/page-pipeline.ts`，整章使用無介面 Session。Google／Chrome 模式預設兩張在途，偵測／OCR 在同一 Worker 的串行佇列執行；翻譯可與下一張 OCR 重疊。Google 背景請求共用串行 lane，請求啟動間隔至少 250 ms。WebLLM／本機 LLM 維持單頁，前頁摘要依完成順序更新。

每張進度攜帶 job ID、圖片序號及階段。停止關閉新任務入口，完成已開始圖片；取消使用 AbortSignal 中止工作。圖片來源或章節變更使舊任務失效。資源錯誤將在途設定改為一張，續翻時套用。

背景圖片 slot 限制全擴充套件最多兩張章節任務，多分頁共用此限制。取消等待中的 slot 會解除等待；已取得 slot 的任務在資源釋放後才歸還。章節列出每張在途圖片的狀態，錯誤保留實際失敗圖片序號。

`cache-page` 訊息交給背景單一 writer 更新快取及索引，各文件不各自修改索引。原文、譯文及人工校正持續保存，完成一張才完整繪圖及編碼。runtime／storage 呼叫由生命週期 helper 接住失效例外，並清理 observer、事件、工作台及待執行任務；舊頁顯示重新整理提示。

### Chrome 本機翻譯

設定頁直接從按鈕呼叫 `Translator.create()`，保留首次下載需要的使用者操作。另用 `Translator.availability({sourceLanguage:'ja',targetLanguage:'zh-Hant'})` 檢查未支援、待下載、下載中及就緒。實際章節翻譯透過 `native-translate` 訊息交給 offscreen 文件的共用 Translator，其佇列與 OCR Worker 分開。設定頁與推論文件的就緒狀態分別確認；不可用時回報原因。

Chrome Translator 使用專用翻譯模型，官方列有日文與繁中。Gemini Nano 的 Prompt API 為通用模型介面，目前官方輸出語言列表尚未包含中文；Chrome 側欄 Gemini 的私人介面限制給元件擴充套件。本版採 Translator，來源見 [Translator API](https://developer.chrome.com/docs/ai/translator-api)、[Prompt API](https://developer.chrome.com/docs/ai/prompt-api) 及 [Chromium 權限定義](https://chromium.googlesource.com/chromium/src/+/main/chrome/common/extensions/api/_permission_features.json)。

## 本機服務

### ONNX OCR

在 Windows PowerShell 中建立 Python 環境：

```powershell
Set-Location -LiteralPath 'C:\path\to\comic-transcriber'
uv venv --python 3.14
uv pip install --python '.\.venv\Scripts\python.exe' -r '.\requirements.txt'
& '.\.venv\Scripts\python.exe' '.\scripts\download-vision.py'
& '.\.venv\Scripts\python.exe' '.\backend\server.py'
```

服務預設綁定 `127.0.0.1:8766`。在擴充套件設定中啟用「獨立本機 ONNX OCR 服務」。服務核對來源及圖片／文字框邊界，不持久保存圖片。

### 本機翻譯

設定 OpenAI-compatible Base URL 與模型名稱即可接入 Ollama、llama.cpp 或相容服務，服務需允許擴充套件 origin。本專案也提供 Windows CPU 伴隨服務：

```powershell
Set-Location -LiteralPath 'C:\path\to\comic-transcriber'
npm run native:assets
& '.\Start-CPU-Translation.ps1'
```

使用 Python 3.14 執行，固定資產列於 `artifacts/native-llm-lock.json`；包括 llama.cpp `b11429` 與 Qwen3.5 0.8B／2B Q4_K_M GGUF。端點為 `http://127.0.0.1:8767/v1`，模型名稱為 `qwen3.5-2b`。下載約 0.5／1.2 GiB 權重，服務以前景程序執行，Ctrl+C 結束。

## 驗證

```sh
npm run typecheck
npm test
```

單元測試涵蓋偵測後處理、端點限制、翻譯重試與取消、部分譯文續翻、快取相容及人工評分計算。瀏覽器章節回歸需要建置含 OCR 權重的套件、Python 測試依賴、Chromium 及原創合成圖片；圖片產生器使用 Windows Yu Gothic 字型。

`node scripts/render-preview.mjs` 啟動只綁定 loopback 的原創繪字比較頁，終端機會顯示 URL。頁面比較矩形與字形白底，顯示框外像素、氣泡輪廓、原文殘留及繪字耗時；按「結束測試伺服器」自然結束程序。本機若已有 `artifacts/bubble-mask-fix/real-regions.json` 與 `real-original.jpg`，會另顯示私人案例比較；公開示意圖使用原創內容。單元測試另外涵蓋 adapter 缺失／失敗／重查、字形空隙、原文超出譯文範圍、背景補色及閉合／開口氣泡。

`node scripts/browser-regression.mjs` 提供互動式正式 Worker／頁面管線回歸。自行取得可使用的編號 JPEG 樣本，放入本機 `artifacts/regression-0.1.9/chapter-21/` 後啟動；瀏覽器按鈕執行第三／四張實際 Google 文字翻譯、整章速度比較或 Chrome 本機翻譯。測試頁使用隔離於擴充套件快取的訊息及儲存 fixture，OCR 權重與正式 Worker 沿用建置產物。

速度比較包含一個冷啟動及一張／兩張各五次暖機，交錯執行以降低順序偏差。每次清除測試頁的對白快取，保留同一組模型；翻譯固定延遲 300 ms，使用串行 Google fixture，沒有反覆外部請求。報告保存階段耗時、峰值在途與執行數、JS heap；JS heap 不包含完整 WASM、GPU 或瀏覽器程序記憶體。這項結果衡量管線重疊，實際 Google 延遲另受網路與限流影響。

0.1.9 的兩張真實樣本已使用正式偵測、OCR 及 Google 對白翻譯完成視覺診斷。人工參考原文、翻譯品質評分與網點修復品質仍待獨立覆核。各版變更集中於 [CHANGELOG.md](../CHANGELOG.md)。

### 0.1.9 量測紀錄

2026-10-14，Chrome、i5-12400、約 16 GB RAM，以 17 張圖片、WASM OCR 及固定 300 ms 翻譯回覆測試。每輪清除對白快取，OCR 模型共用；一張／兩張各五次，交錯順序。

| 項目 | 一張 | 兩張 |
|---|---:|---:|
| 暖機整章中位耗時 | 268.71 秒 | 217.11 秒 |
| 五次範圍 | 266.37–280.60 秒 | 207.73–224.36 秒 |
| 峰值在途圖片 | 1 | 2 |
| 峰值 OCR／偵測執行 | 1 | 1 |
| 峰值翻譯請求 | 1 | 1 |
| 完成時 JS heap 範圍 | 97.9–111.6 MiB | 111.5–116.7 MiB |

一張冷啟動耗時 249.44 秒；兩張暖機中位時間縮短 19.2%，吞吐量約 1.24 倍。背景分頁與系統負載會影響結果。這組量測使用開發候選版的相同 OCR Worker 和管線；後續介面、全分頁圖片額度與氣泡字形孔洞判斷修正另以單元及最終繪字回歸確認。數字代表固定翻譯延遲下的重疊效果，不能直接當作 Google 線上整章速度。

最終原創圖像素檢查：淺底氣泡與平坦插畫底各一組，框外及輪廓改動均為零，檢查區域的原文殘留為零；改動像素比矩形模式少 79.6%／75.2%。真實第三／四張沿用已保存的 OCR 與譯文重排，觀察到大型原文清除、中文放大與自動直排；網點上仍可能有局部補色痕跡。另一次 Google 重測收到實際 429，停止外部請求並保存已完成文字。

Chrome Translator 的日文→繁中語言包可在使用者點擊後建立；localhost 上 16 段已辨識文字暖機翻譯約 211 ms。短句、人名及慣用語仍有誤譯，人工品質評分未完成。擴充套件 offscreen 的可用性須在設定頁另外檢查；localhost 的成功結果不能代替擴充套件來源驗證。

實際擴充套件測試已觀察到兩張在途、停止後兩張完成即呈現、重新整理後六張快取恢復、取消後六張結果保留。重新載入擴充套件、保持舊漫畫分頁時，更新提示出現且六張結果仍在，沒有捕捉到未處理的 context invalidation 錯誤。設定頁由使用者回報日文→繁中「就緒」；offscreen 診斷文字尚待實機記錄。62 個單元測試已確認同步／非同步失效清理、硬取消等待所有在途工作收尾。瀏覽器工具限制讀取擴充套件內部頁，捕捉到的漫畫頁日誌不能代替擴充套件管理頁的錯誤紀錄。

2026-10-15 最後實機續翻完成第 21 章 17/17 張，DOM 中有 17 個結果圖片，沒有圖片錯誤記錄，也沒有捕捉到未處理的 context invalidation 錯誤。懶載入閱讀器會再次指定相同網址；早期候選版因此在第 13／14 張誤取消。最終版記錄在途圖片來源，忽略相同 src 及未使用的空 srcset 指派，真正換圖仍取消。續翻包含既有文字快取，這次完成狀態用於相容性驗證，速度比較採上表獨立重置快取的量測。

```powershell
Set-Location -LiteralPath 'C:\path\to\comic-transcriber'
& '.\.venv\Scripts\python.exe' '.\scripts\make-corpus.py'
npx playwright install chromium
$env:TEST_TRANSIENT_500 = '1'
node '.\scripts\chapter-e2e.mjs'
Remove-Item Env:TEST_TRANSIENT_500
```

測試執行實際 ONNX 偵測及 OCR，Google 翻譯回覆由 fixture 提供；檢查逐張呈現、停止／續翻、暫時 HTTP 500、原圖切換、全部縮圖與已存文字恢復。它驗證管線與介面，人工對白標註和翻譯可讀性另行評分。其他研究與比較程式位於 `scripts/`，真實漫畫測試需自行取得可使用的樣本。

## 0.1.10 資源與實驗來源

快取管理頁為 `cache.html`。頁面資料以 `chrome.storage.local.getBytesInUse()` 計量，模型快取記錄實際內容長度，舊項目可串流掃描。`bundle-inventory.json` 由建置產生，離線權重加入套件後會重新計算。模型下載快取與套件內權重可能同時存在，兩者分開列出。

背景維持跨分頁圖片額度與資源使用記錄，offscreen 文件負責 60 秒閒置計時。狀態頁讀取已存快照，不建立模型；關閉與新任務交錯時等待關閉完成。工作中的快取刪除會被拒絕，頁面寫入、模型計量索引及刪除沿用單一寫入佇列。

WASM 執行緒設定於建立任何 session 前套用。需要 COOP／COEP、Worker 隔離及 SharedArrayBuffer；多執行緒無法初始化時，重新建立單執行緒 Worker並顯示原因。執行中的設定變更延至下次釋放後生效。原生服務可指定執行緒：

```powershell
Set-Location -LiteralPath 'C:\path\to\comic-transcriber'
python backend/server.py --threads 4
```

匿名 Gemini 由可見設定頁請求網站權限與啟動 30 批驗證，offscreen 文件持有單一序列。所有請求使用 `credentials: omit`，不接入登入會話或網站可執行程式。診斷資料及未知結果鎖保存本機；403／429、協定變更或不完整回覆會停止後續請求。研究入口與固定輸入／整章速度比較見 [0.1.10 研究報告](research-0.1.10.md)。

## 0.1.11 整章校正

`src/chapter-refinement.ts` 將整章的頁序、原文、初譯與目前譯文組成單一輸入，回覆使用頁面及區域 ID。可校正項目全部核對通過後才回填；模型輸出只能改文字，排版及幾何沿用本機資料。`initialTranslation` 保存每框初譯；`PageData.refinement` 保存輸入／輸出與術語指紋，避免重複請求與過期回覆。

content script 經背景的 `gemini-status` 檢查權限與協定，再送 `gemini-refine`；offscreen 沿用單一 Gemini 請求序列與未知鎖。content script 不直接呼叫僅擴充套件頁可用的 permissions API。初譯設定中的舊 `gemini-web` 值在讀取時改為 `google-web`，整章校正由 `refineAfterChapter` 控制。

工具列使用 Shadow DOM；pointer capture 必須綁定 composedPath 中的拖曳元素。收合與展開透過操作鈕中心及 ResizeObserver 對齊位置。Chrome 驗證與品質界線見 [0.1.11 紀錄](research-0.1.11.md)。

## 目錄

| 目錄 | 用途 |
|---|---|
| `entrypoints/` | service worker、content script、popup、設定頁、工作台及 offscreen 文件 |
| `src/` | OCR／翻譯 Worker、章節佇列、校正介面、嵌字、快取與模型清單 |
| `backend/` | 選用的 ONNX OCR 與 CPU 翻譯服務 |
| `tests/` | 插件與本機服務測試 |
| `scripts/` | 資產準備、建置核對、瀏覽器回歸及模型比較 |
| `artifacts/` | 本機研究結果；Git 僅保留兩份模型鎖定清單 |
| `public/` | 準備後的執行資源、字型及授權文件 |

## 回報問題

Issue 請附擴充套件與瀏覽器版本、翻譯模式、操作步驟及錯誤訊息。網站相容性問題可附閱讀器網址或經授權的最小範例；OCR 問題可附裁切範例與正確原文。帳密、cookies、完整瀏覽器 profile 及無權公開的漫畫內容應留在本機。
