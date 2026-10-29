# OCR 優化實裝與驗收｜0.1.16

更新時間（UTC）：2026-10-29T02:27:20Z。本機候選；公開發布另行處理。

## 採用結果

預設採 INT8 MangaOCR 一般解碼＋WASM 自動多緒；全精度模式採 KV，按需要另行下載。固定 50 框、同為 WASM 4 緒的獨立三次暖機如下。全章準確率首輪與暖機效能分開保存。

| 模型 | 50框中位 | 合成CER | 漫畫AI參考CER | 主要renderer峰值 |
|---|---:|---:|---:|---:|
| 全精度一般 | 36.114s | 0.00% | 26.14% | 1468.6MiB |
| INT8 一般（預設） | 14.781s | 0.00% | 26.14% | 846.1MiB |
| 全精度 KV（可選） | 23.584s | 0.00% | 26.14% | 1459.1MiB |
| INT8 encoder＋浮點 KV | 17.410s | 0.00% | 26.14% | 929.6MiB |
| INT8 encoder＋QInt8 KV | 15.177s | 0.00% | 26.14% | 747.4MiB |

- INT8 權重含字表 111.37 MiB，全精度一般模式 439.61 MiB，縮減 74.67%。
- 全精度 KV：479框逐步 token／EOS 零差異，固定50框暖機縮短 34.69%。
- INT8＋浮點KV相對INT8一般模式耗時增加 17.78%；QInt8 KV增加 2.67%，均未達至少15%加速門檻，維持研究候選。
- 五組都完成479框；相同CER不代表逐框相同，所有差異保留。真實漫畫47個可計分參考為AI視覺覆核，待人工確認；宣傳頁及扉頁未建立參考，讀序仍待獨立覆核。
- 記憶體為隔離測試主要renderer的lifetime Working Set峰值，包含量測器；不同程序峰值不相加，也不作正式插件RAM保證。

## 使用行為

- 模式分別下載；切換profile／provider先釋放舊OCR sessions，KV只活在單一框。auto依CPU邏輯緒數的一半、最多4緒；隔離/SAB不成立或初始化失敗明確回退單緒。
- 工作台可看原裁圖、單框重辨、切換模式比較，最多兩份候選，選擇套用後才變更原文；變更只清除該框譯文及章節校正指紋。支援畫線拆框、預覽、套用與撤銷。
- 偵測分數與OCR信心分開，缺值顯示未提供。模型／前處理加入快取身分；legacy須明確載入，保留舊身分至新OCR被採用。schema1候選白名單、私人Reader與網站工作台隔離。

## 隔離擴充功能驗收

| 執行組 | 狀態 | profile／框數 | 執行緒及資源 |
|---|---|---|---|
| extension-chromium-t1 | passed | int8 50框、fp32 50框 | int8: 1緒、fp32: 1緒 |
| extension-chromium-t4-final | passed | int8 50框、fp32 50框 | int8: 4緒、fp32: 4緒 |
| extension-chromium-t4 | passed | int8 479框、fp32 479框 | int8: 4緒、fp32: 4緒 |
| extension-msedge-t1 | passed | int8 50框、fp32 50框 | int8: 1緒、fp32: 1緒 |
| extension-msedge-t4-final | passed | int8 50框、fp32 50框 | int8: 4緒、fp32: 4緒 |
| extension-msedge-t4 | passed | int8 479框、fp32 479框 | int8: 4緒、fp32: 4緒 |
- extension-chromium-t4-final：passed；閒置釋放實測 60.13秒。
- extension-msedge-t4-final：passed；閒置釋放實測 60.10秒。

隔離測試採Chrome for Testing（Playwright Chromium）及Edge；現場使用者Chrome另列。完整矩陣後新增暖機取消訊息檢查點，標記final的兩組是最後建置的固定50框回歸，並檢查progress同步取消、恢復與legacy新快取隔離。原始失敗收據保留，未拿後續成功覆寫診斷。

暖機取消的原因是連續WASM解碼可能只排入微任務，使Worker取消訊息不能及時執行。現在每8步以MessageChannel交回訊息佇列；新增回歸測試及兩瀏覽器實際Worker驗證。載入提示也分為準備、實際下載與初始化。

## 五項後續研究結論

| 方向 | 結論與證據 |
|---|---|
| 裁切留白／切列／註音分離 | 479框獨立對照；合成CER由0變為0／26.30%／0.758%，AI漫畫26.14%變為33.27%／38.94%／26.14%。停止自動採用，保留手動拆框。 |
| Screen AI幾何讀序 | 合成CER9.18%→7.67%，AI漫畫34.00%→34.19%；35框讀序變化、38個越界字元座標。保留研究，尚未加入自動讀序。 |
| 原生隔離與資源管理 | 同PID三次、EOF、閒置退出及注入故障的獨立子程序測試通過；故障與空結果分開。測試閒置1秒，正式插件60秒另測。 |
| Tank-OCR Go FFI | 固定commit 3f9fbacad3e0ee357ff19bf334375524c292d13e，隔離可攜Go編譯後連續呼叫本機153.4成功。保留免Python候選，沒有正式服務／安裝器交付。 |
| 固定日文依賴精簡 | 完整初始化成功、追蹤35個檔案；限制其他語系檔案後初始化false。停止本輪精簡。 |

hanijpan完整移植仍維持停止投入；未反編譯DLL、未開發私有算子。原始結果及來源快照留在本機。

## 現場Chrome與交付

現場驗收狀態：partial；指定GPT-6.1 Terra、medium子智慧體在使用者已開啟的Chrome Rawkuma分頁操作，其他插件保持原狀。版本與修正版重載由使用者確認，未繞過browser-use政策去讀管理頁。

已觀察INT8/standard/wasm、候選保留及套用、拆框撤銷、Google單張文字翻譯、套用、重開保留與原圖切換。修正版也已重開及重辨。

限制：一框預設擦字仍有日文殘留；手動白底可消除重疊但遮到對話框邊線。現場取消按鈕因OCR已完成而脫離DOM，取消效果未觀察；不能拿自動化點擊錯誤判定產品取消失效。單張整體重辨沿用原流程，會清除該張譯文及先前候選；新增單框比較可先保留原文。相鄰圖片可見，動態懶載入與其他插件的全面相容性仍未獨立證明。

完整操作與截圖：本機 `live-chrome/acceptance.md`、`acceptance.json`。

本機ZIP：`dist/comic-transcriber-0.1.16-offline-vision.zip`，155,869,424bytes，SHA-256 `34a0767183a14b0e95e1e224c189594059df19ea7fc3699572984b4d24c7fce8`；CRC、manifest與逐檔核對passed。

## 完整性驗證

146項測試通過，型別／建置／離線權重白名單通過；最後建置在兩瀏覽器通過暖機取消、恢復、legacy分離保存及60秒閒置。完整來源、執行副本、逐框ID、QA與ZIP雜湊由 `implementation-manifest.json` 綁定；現場Chrome的partial狀態保留。

來源與復現：`combo/adoption.json`、`combo/implementation-summary.json`、完整Canvas及sample結果／receipt、各研究probe腳本。程式及權重固定身分以manifest與交付收據為準；漫畫、Screen AI元件與外部研究程式碼不進Git或插件ZIP；預設INT8與偵測器權重隨離線套件提供。
