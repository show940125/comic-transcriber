# 本機容量管理

模型、測試瀏覽器設定檔與發布包各有獨立副本。容量檢查以檔案內容大小計算；Windows 配置空間與瀏覽器記憶體用量另行衡量。

## 檢查及清理

在專案根目錄執行：

```powershell
npm run storage:report
npm run storage:clean -- --apply
```

兩個命令預設均為唯讀預覽；只有 `--apply` 會刪除列出的可重建資料。操作前先保存清單，逐項記錄結果，報告位於本機 `artifacts/storage-cleanup/`。刪除後需要舊套件或原始語料時，須重新取得。

清理範圍：

- 已知測試程式建立的隔離瀏覽器設定檔。`chrome-translator-installed.json` 指向的語言包設定檔保留，供本機翻譯基準重用。
- `artifacts/release-archive/日期目錄` 內的舊發布 ZIP。刪除前核對 `dist` 最新兩版的 SHA-256；歷史 manifest 保留作來源與雜湊紀錄，實際刪除結果以清理報告為準。
- `.cache/corpus/001bj.zip` 與 `volume-01.pdf`。已擷取測試圖片、來源授權及辨識／翻譯結果保留；重新擷取時由語料準備程式下載。

原始碼、Git 歷史、`.output/chrome-mv3`、`dist` 最新兩版、模型、執行資源、依賴、人工校正與研究報告均保留。瀏覽器仍在使用的設定檔會跳過；無法讀取瀏覽器程序資訊時，設定檔清理停止。遇到 junction、符號連結或越界路徑會拒絕操作。

## 測試與發布保留規則

一般自動化測試使用新建的隔離設定檔，關閉瀏覽器完成後清理；測試報告、截圖及匯出結果獨立保存。設定檔的收尾結果另存於 `artifacts/test-profile-lifecycle/`，包含啟動及關閉失敗。啟動失敗也會嘗試清理；瀏覽器未完成關閉或目錄仍被占用時保留，交由容量檢查列出。Chrome 語言包基準重用指定設定檔。

`npm run package` 先驗證新 ZIP 的 CRC、manifest 版本及必要檔案，再發布套件，依數值版本保留最新兩版及兩者的 `SHA256.txt`。淘汰的版本、大小與雜湊記錄在本機 `artifacts/release-history.json`，避免持續累積大型舊 ZIP。

目前安裝的擴充套件使用 `.output/chrome-mv3`，清理時保留此目錄。重新建置會改寫該目錄，屬於獨立開發操作。
