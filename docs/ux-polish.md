# 0.1.19 介面細修與驗收

這版沿用已驗收的三欄章節工作台。讀者可在縮圖換頁、在漫畫預覽選框、在右側比較與校正。採用 OCR 候選只改當前一框，「套用至漫畫頁」才更新譯圖。

## DesignBookmark 元件評估

| 參考元件 | 墨譯的取捨 |
| --- | --- |
| Segmented control、Tab pill | 「原圖／譯圖」與「文字／排版」共用分段樣式。保留原生按鈕與鍵盤焦點，透過按下狀態呈現目前選項。 |
| Step progress、Loading to success | 進度條以已可閱讀頁數和章節總頁數計算。等待 Gemini、校正完成與回覆未知各有自己的文字，讀者可以判斷目前可讀多少頁。 |
| Bottom bar | 底列把儲存狀態與「套用至漫畫頁」放在一起。校正已儲存但譯圖待更新時，以暖色標記並顯示下一個動作。 |
| File drop | 保留作為本機選圖的候選。加入前須驗證檔案上限、錯誤回饋及只在獨立工作台接收檔案的範圍。 |
| Command palette、Rubber dock | 本輪先保留頁面工具與擴充套件彈窗的固定入口，常用操作可以從現有標籤找到。 |

元件用專案既有的 Svelte 和 CSS 實作，按鈕僅短暫過渡底色與邊線。系統開啟減少動態效果時關閉過渡。[DesignBookmark Motion](https://designbookmark.com/motion) · [Emil Design Engineering](https://github.com/emilkowalski/skills/tree/main/skills/emil-design-eng)

## 以實際套件壓測

依 `break-ui` 的方法，先用相同校正檔跑 0.1.18，再跑 0.1.19。總共 12 組配置，涵蓋 1 或 60 頁、空結果、單一空候選、一頁 300 框、約 1,450 字元的候選和 300 字元的診斷訊息。[break-ui](https://github.com/emilkowalski/skills/tree/main/skills/break-ui)

| 情境 | 0.1.18 | 0.1.19 |
| --- | --- | --- |
| 長候選卡高度，1280／390／320 px | 1,939／1,876／2,456 px | 359／355／308 px。長文可在卡內以鍵盤或指標捲讀，採用按鈕和影響提示留在捲動區外。 |
| 320 px 的長診斷訊息 | 警示橫向溢出 32 px | 文字可換行，量測的文字及側欄均無橫向溢出。 |
| 只有一份空候選 | 同一份結果也出現在先前候選 | 只顯示一次，按鈕標明採用空結果，旁邊提示會清除當前框的原文和譯文。 |

在 1280 × 820、390 × 660 和 320 × 480 的測試中，「套用至漫畫頁」均留在工作台底列。抽測一般文字、標註、按鈕和提示，最低對比為 6.04:1。

## 瀏覽器驗收

- **0.1.18 個人 Chrome。** 在 Rawkuma《Tensei Goblin》第 24 話驗證 17 頁縮圖與換頁、Escape 關閉及焦點返回。使用者另回報同一章已完整翻譯成功。
- **0.1.19 隔離 Chromium／Edge。** 用原創漫畫驗證章節模式互不干擾、進度、拆框、取消與撤銷、候選採用、匯入、套用譯圖及快取刪除範圍。Chromium 額外實跑 RT-DETR、INT8 MangaOCR 與全精度 KV 辨識。翻譯服務使用本機固定回覆。
- **0.1.19 整章直譯回歸。** 29 頁可沿用已快取的 OCR，收到一次 Gemini 測試回覆後套用全章。相同輸入重跑可直接讀回已驗證結果。

依 [開發文件](development.md) 產生原創測試圖片、安裝 Playwright Chromium 並建置擴充套件。在 PowerShell 指定套件路徑後可重跑以下操作。

```powershell
$env:COMIC_BUILD_DIR = '.output/chrome-mv3'
$env:COMIC_UI_STRESS_STRICT = '1'
node scripts/ui-stress.mjs
node scripts/ux-regression.mjs
$env:TEST_BROWSER = 'msedge'
node scripts/ux-regression.mjs
node scripts/chapter-direct-regression.mjs
```

如要重跑真實 OCR，在 Chromium 回歸命令前加上 `$env:COMIC_UX_ACTUAL_OCR = '1'`，並依開發文件準備預設及全精度權重。量測和畫面存於本機 `artifacts/`。
