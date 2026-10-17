# 0.1.15 本機檔案隔離與交付驗證

日期：2026-10-18。

## 行為與安全邊界

網站工作台移除本機 file input；本機選圖開啟獨立 extension Reader，校正 JSON 使用獨立匯入分頁。使用者確認後，背景僅交付經白名單重建的文字框資料，接收端再次核對工作台與原圖狀態。原始 File、JSON 全文及額外欄位留在匯入分頁。

匯入工作階段期限 10 分鐘，綁定來源 tab、frame、document、網址、工作台實例、圖片雜湊及尺寸，以及匯入 tab 與網址；成功後消耗，失效或回覆未知時禁止重送。獨立 Reader 新保存的校正使用私人快取識別，避免同圖網站工作台透過共用快取讀回。舊共用資料保留，獨立 Reader 不再自動載入，使用者可透過 JSON 明確匯入。

- [ ] **低度｜未修復／待修復：DNS 指向內網的背景讀圖風險。** 本版僅隔離驗證與註記，正式讀圖政策維持原狀。詳見 [安全邊界](security.md)。

## 本機驗證

| 項目 | 結果 |
|---|---|
| TypeScript／Svelte | 0 errors、0 warnings |
| 插件測試 | 138 通過，涵蓋工作階段所有權、過期、導覽、未知回覆、巢狀欄位白名單及快取隔離 |
| Chromium 156.0.8078.4／Edge 155.0.4283.45 | 原創 fixture 回歸；本機選圖、校正匯入、人工編修、PNG／JSON 匯出、套用、原圖切換、整章翻譯及取消 |
| Python 3.14 後端 | OCR HTTP 4 項、翻譯 HTTP 3 項通過；原創合成圖片與翻譯 fixture，測試服務自然結束 |
| WXT 建置／套件審核 | Manifest V3，無新增網站權限；OCR 權重與鎖定雜湊／大小一致 |
| ZIP 交付核對 | 全部 CRC、必要檔案、manifest 版本、54 個項目與建置逐檔一致；無漫畫或額外 GGUF |

瀏覽器使用全新隔離 profile，翻譯回覆全部為 fixture，非測試來源請求均拒絕。正常瀏覽器的安全功能維持預設。DNS 測試只接觸本機提供的原創圖片，兩款瀏覽器都能取得 hostname 映射至 loopback／本機私人介面的圖片，HTTP 302 與字面 loopback IP 拒絕；低度問題保留未修復。實際 OCR／翻譯品質與使用者重載後的現場功能另屬驗收範圍。

後端測試仍有既有 HTTPError 清理 ResourceWarning，測試結果通過；本版未調整後端。`npm run report` 更新的是歷史研究資料的彙整，未將其當作本輪新測量。

## 交付識別

- 套件：`comic-transcriber-0.1.15-offline-vision.zip`
- 大小：484,139,605 bytes
- SHA-256：`1bb380f43f378bd8f2e9222d15fa30b49be4d64a1d3475fbc0e16065f05c53bd`
- 本機證據：`artifacts/zip-verification.json`、`artifacts/delivery-manifest.json`、`artifacts/release-0.1.15/`；隔離資安報告與截圖另存本機受管證據目錄，不提交瀏覽器 profile 或本機網路資訊。
- 公開版本入口：[v0.1.15](https://github.com/show940125/comic-transcriber/releases/tag/v0.1.15)。公開狀態、來源 commit、CI 與附件 digest 依 GitHub 收據核對，獨立於本機套件檢查。

本機 `.output/chrome-mv3` 已準備新版與離線 OCR 權重。瀏覽器重載由使用者執行；重載後再重新整理漫畫分頁。沒有自動重載目前安裝的插件，也沒有遷移或清除使用者快取。
