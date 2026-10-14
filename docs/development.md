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
