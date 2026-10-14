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

工作台及設定頁開啟時不主動探測 GPU。WebLLM 或選用 WebGPU OCR 時才呼叫 adapter，結果包含不可用狀態均在 Worker 中快取；設定頁的「檢查 WebGPU」可重新檢查。程式自身呼叫 `requestAdapter()` 時省略 Windows 不採用的 `powerPreference`，WASM 路徑不需這項探測。WebLLM／ONNX 的內部 GPU 呼叫仍受第三方執行庫與瀏覽器限制，真正的 GPU 失效會保留診斷。

字形白底先辨認文字框內高對比筆畫，排除跨邊界的大型氣泡輪廓，向外擴張少量像素後，以鄰近未遮蔽像素補色。中文以 Canvas 繪出字形遮罩，擴張圓形描邊並填滿封閉空隙，再畫上不透明白底和黑字。這是 CPU 局部補色，細緻插畫上的修復仍需人工檢查；矩形浮層和手動白底保留為逐框選項。

`src/bubble-mask.ts` 從文字框周圍的原圖尋找連通淺底區域，優先使用閉合氣泡內部。氣泡在頁邊或格邊開口時，保留連通淺底並補入小型文字孔洞，大型輪廓與插畫區域維持原樣。補色遮罩、中文字形及白底均限制在辨認出的內部；排版使用內部最大矩形。無法辨認氣泡時，只有邊界顏色一致的背景會自動補色，其他區域保留原文供人工處理。

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

```powershell
Set-Location -LiteralPath 'C:\path\to\comic-transcriber'
& '.\.venv\Scripts\python.exe' '.\scripts\make-corpus.py'
npx playwright install chromium
$env:TEST_TRANSIENT_500 = '1'
node '.\scripts\chapter-e2e.mjs'
Remove-Item Env:TEST_TRANSIENT_500
```

測試執行實際 ONNX 偵測及 OCR，Google 翻譯回覆由 fixture 提供；檢查逐張呈現、停止／續翻、暫時 HTTP 500、原圖切換、全部縮圖與已存文字恢復。它驗證管線與介面，人工對白標註和翻譯可讀性另行評分。其他研究與比較程式位於 `scripts/`，真實漫畫測試需自行取得可使用的樣本。

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
