# 0.1.13 網站權限驗證

日期：2026-10-15。

## 問題與處理

舊版只取得漫畫頁的 origin 權限，圖片可能由另一個 CDN 提供。背景 `fetch-image` 檢查圖片 origin 時會回覆未授權，即使漫畫頁本身已可使用。

0.1.13 將所有 HTTP／HTTPS 網站列為 required host permissions，涵蓋漫畫頁、圖片 CDN 與既有服務來源。插件圖示及設定提供「授權所有網站與圖片 CDN」入口；Chrome 手動收回權限時可由使用者點擊恢復。Chrome 安裝／更新權限確認由瀏覽器處理，詳見 [官方權限文件](https://developer.chrome.com/docs/extensions/reference/api/permissions#method-request)。

頁內工具與模型保持按需啟用。自動翻譯的 `autoSites` 僅接受具體網站，所有網站的權限 pattern 不會成為自動翻譯目標。瀏覽器測試發現 Chrome 的 `URL('http://*/*').hostname` 為 `%2A`，Node 可能保留 `*`；因此同時檢查原始 authority 和解析後 hostname。

## 驗證

- 118 個測試及型別檢查通過，含跨域圖片、Chrome 限制權限時的提示、私人端點封鎖、全網站權限與自動翻譯清單分離。
- 隔離 Chromium 新設定檔：預設取得 HTTP／HTTPS 全網站權限，確認包含 `https://a2.gold-usergeneratedcontent.net/*`。
- 原創合成圖由本機伺服器提供，以測試專用 DNS 規則映射不同漫畫與 CDN hostname；背景讀取無 CORS 標頭的跨來源圖片，位元組與原檔完全一致，沒有另外授權圖片 origin。
- 設定頁的全網站權限按鈕可用；普通漫畫頁未啟用時沒有 content script 或推論 Worker。
- 指定一個自動翻譯網站後，實際註冊的 content script 僅包含該網站，UI 與註冊清單均不包含全網站 wildcard。
- 本次未讀取真實漫畫 CDN，也未測其 cookies、登入、防盜連或其他 HTTP 限制；未送出遠端翻譯請求。

重現命令：`node scripts/permissions-regression.mjs`，需要已建置的擴充套件與本機原創合成語料。報告與截圖位於 `artifacts/regression-0.1.13/`，保持本機；測試瀏覽器設定檔關閉後清理。
