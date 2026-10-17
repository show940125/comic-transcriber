# 本機檔案的安全邊界

網站上的工作台使用 Shadow DOM 呈現，宿主仍能觀察其中的 DOM 與已顯示內容。因此本機選圖與校正檔案選取集中於擴充套件的獨立分頁。

## 操作方式

- 「選擇本機圖片」開啟獨立工作台。本機圖片、File 及預覽留在該分頁；OCR 與翻譯仍依使用者設定處理，雲端文字翻譯的資料流維持原樣。
- 漫畫頁的「載入校正」開啟獨立匯入分頁。選取不超過 2 MB 的 JSON 後，程式檢查圖片雜湊、尺寸及文字框。按「匯入到漫畫頁」才交付經白名單重建的資料，成功後切回原漫畫分頁。
- 原始 JSON、File、額外根欄位與幾何中的額外欄位留在匯入分頁。明確匯入的原文、譯文與框線會出現在漫畫頁，宿主可觀察這些已交付內容。
- 工作階段有效 10 分鐘。換圖、關閉工作台、來源導覽／關閉、匯入分頁變更及背景重啟會使它失效。失敗或結果未知時不自動重送；核對原工作台後，必要時重新開啟。

新產生的獨立工作台快取使用私人識別，網站工作台無法藉相同圖片雜湊讀入。既有共用快取保留，歷史資料無法可靠判定來源，並未自動清除或分類；可於「快取與資源管理」檢視、刪除，或使用 JSON 明確匯入。快取 schema、OCR、翻譯與嵌字引擎維持原有格式與流程。

## 仍待修補：DNS 指向內網

- [ ] **低度｜未修復／待修復：DNS 指向內網的背景讀圖風險。** 本輪僅完成隔離驗證與註記，修補另行安排。

背景讀圖代理會拒絕字面私人 IP 與特殊 hostname，並檢查圖片格式、大小及轉址。一般 hostname 的實際 DNS 位址尚未受到完整限制。隔離 Chromium 與 Edge 的結果須依個別測試報告判讀；受控 hostname 指向本機 loopback 或本機私人網路介面時，可能仍可取得測試圖片。因此此低度問題保留為未修復。

本輪維持正式讀圖政策及網站權限。後續限制需同時評估跨來源 CDN、解析結果與連線目的地的一致性、轉址及瀏覽器的 Local Network Access 行為；單純新增 hostname 黑名單不足以關閉此路徑。

## 重現與回歸

`tests/correction-import.test.ts` 涵蓋工作階段所有權、跨 tab／frame／文件、過期、關閉、導覽、重複提交、未知回覆、無效區域與私人快取識別。`scripts/security-regression.mjs` 使用原創圖片、預存 OCR、fixture 翻譯與全新瀏覽器 profile；拒絕非測試來源請求。DNS 測試伺服器只提供本機合成圖片，使用 loopback 與本機介面，不接觸其他內網服務，也不關閉瀏覽器安全功能。

先將 WXT 建置輸出至獨立暫存目錄，避免覆寫目前安裝版本，再執行：

```powershell
node --import tsx scripts/security-regression.mjs --extension 'C:\test-build\chrome-mv3' --output 'C:\test-evidence\chromium'
node --import tsx scripts/security-regression.mjs --extension 'C:\test-build\chrome-mv3' --output 'C:\test-evidence\edge' --browser edge
```

`--baseline` 用於在隔離 profile 重現舊版選檔暴露。請將輸出放在 Git 以外的暫存／證據目錄；profile、測試匯出、截圖與本機網路資訊不應提交。建置及測試通過只適用於該次原始碼與隔離建置，不代表目前安裝中的插件已更新。
