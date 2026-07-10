# 永平整復保健 — Sheet→APP 同步 Worker

## 現況（120 個測試全過，功能完整、沒有 stub 了）

- `src/diff.js` — 比對前後兩份快照，抓出新增/異動/刪除/不變
- `src/snapshotStore.js` — R2 存快照歷史 + log（原生 R2 binding，不需要 Access Key/Secret）
- `src/weekKeys.js` — 算出要同步哪幾週（台灣時區正確處理）
- `src/sheetsSerial.js` — Google Sheets 序列日期/時間 ↔ 字串互轉
- `src/googleAuth.js` — 服務帳號 JSON 簽 JWT 換 access token（純 Web Crypto，Workers 相容；用讀寫 scope，見下方權限說明）
- `src/sheetsApi.js` — 呼叫 Sheets API v4 讀格子內容+底色，也能寫儲存格備註
- `src/sheetParser.js` — **把讀到的 2D 格子資料切成結構化預約記錄**，見下方「Sheet 結構」
- `src/sheetWriter.js` — 驗證失敗/衝突時，在對應儲存格寫備註(note)提示師傅；用備註而不是改內容/顏色，天生不影響 diff 用的 contentHash，不需要額外防迴圈機制
- `src/validate.js` — 從 booking repo（師傅端 app）的 CSV 匯入驗證邏輯直接搬過來對齊
- `src/supabaseClient.js` — 寫入/查詢 Supabase 的 HTTP/認證機制
- `src/index.js` — 串起整個流程的 Worker entrypoint（cron + 手動 `/sync`）

`sheetsApi.js` / `googleAuth.js` / `sheetWriter.js` 需要真的打 `sheets.googleapis.com`，我的 sandbox 對外網路沒開放這個網域，沒辦法在這裡實際跑過一次——邏輯是照 Sheets API v4 文件寫的，**部署後第一次跑務必看 log 確認有正常抓到資料、備註有寫進去**。

**權限**：sheetWriter 要寫備註，需要編輯權限——已經用 Drive API 查過 Sheet 的共用設定，目前是「知道連結的人都能編輯」，服務帳號本來就有寫入權限，這塊不用另外處理。

## 師傅姓名對照（已確認）

Sheet 分頁用的是暱稱「泓文、哲瑋、麒、治」，Supabase `masters.name` 存的是正式名字。已確認：**麒 = 許老師、治 = 魏老師**（泓文/哲瑋本身就是正式名字，兩邊一致）。程式已經處理這個轉換（`SHEET_MASTERS` 的 `masterDbName`），每筆記錄的 `masterName` 是正式名字（拿去對 `masters.name`），`sheetMasterLabel` 是分頁暱稱（`sheetWriter.js` 寫回備註時要用這個找對分頁，不能用正式名字）。

## Sheet 結構（已對照真實的「2026-永平整復預約表」驗證，不是猜的）

- 一個月一個分頁，命名「{N}月-{師傅名}」（N 不補零，例如「7月-泓文」）。另外有「{N}月-合併」（泓文+哲瑋併排版），內容跟兩人個別分頁逐格比對完全一致，所以只讀四個獨立分頁。
- 分頁第 1 列固定「週日～週六」7 個標籤，只出現這一次。
- 每個「週區塊」：第一列（A欄="時間"）放當週日期（月初/月底跨月那幾欄是空的）；接著 30 列是每半小時一格的時段（8:00~22:30）；再來「人數」小計列；再 2 列空白，下一週的區塊接著開始。
- **顏色**：黃底（`#FFFF00`）= 新客（已確認）。紅底（`#FF0000`）= 休假或不開放時段（已跟 Hanna 確認，預設當休假處理），不是真正顧客預約，但格子裡原本的文字會保留當備註，不會被覆蓋掉。其他顏色（米色/白/透明/藍/青）還是沒有規律，不猜。
- **延續符號（多時段預約）**：同一筆預約橫跨多個時段時，後面時段填的是「同格延續」符號而不是重打名字。四位師傅都已確認：**麒用 ”（U+201D）、泓文/哲瑋用 ''（兩個直引號）**，會自動合併。**治用「*」，但意思不是延續——是「舊客預約、治不想打名字」**，所以治的「*」會產生一筆獨立預約，`customerName` 填「舊客」佔位，不會被誤判成延續符號。

## 關於 extract_history.py

booking 跟 yongping-customer2 兩個 repo 都搜過（檔案樹 + 關鍵字），確定沒有這個檔案。原本要從這支拿的驗證邏輯，已經在 booking repo 的 CSV 匯入功能裡找到「正式在用」的那份、直接搬過來了；顏色/延續符號則是直接讀真實 Sheet 資料反推出來的（見上面兩節），不需要那支遺失的腳本了。

## 關於顧客資料

寫這段邏輯時有讀取 Sheet 上的真實內容（含顧客姓名、電話），純粹用來確認格式；測試檔案裡的範例一律用假名（測試客甲、王小明這類），下載過程中產生的暫存檔（xlsx）已經刪除，沒有真實顧客資料留在這個專案裡。

## 一次性月份校正（`/reconcile-month`）

「app 目前測試階段，Sheet 才是最準的」——這個端點用來把某個月份的 APP 預約資料對齊 Sheet：Sheet 上找不到對應（同師傅/日期/時間）的 DB 預約，會被標記成 `status='cancelled'`（不是刪除，資料還在可以查回來）。**不是排程的一部分**，要手動觸發。

安全機制：預設 `dryRun: true`，只回報「會取消哪些」，不會真的動手；先看過 dry run 結果（含每一筆的師傅/日期/時間/客戶名/來源），確認沒問題後才帶 `"dryRun": false` 真的執行。

```
curl -X POST https://yongping-sheet-sync.yihanhsu123.workers.dev/reconcile-month \
  -H "X-Internal-Secret: <INTERNAL_SYNC_SECRET 的值>" \
  -H "Content-Type: application/json" \
  -d '{"year": 2026, "month": 7}'
```

確認 `toCancel` 清單沒問題後，同一個指令改成 `"dryRun": false` 才會真的執行。

## 部署前要做的事

1. **建 R2 bucket**（取個名字，例如 `yongping-sheet-sync`）：
   ```
   wrangler r2 bucket create yongping-sheet-sync
   ```
   建好後把同樣的名字填進 `wrangler.toml` 的 `bucket_name`。
2. ~~服務帳號編輯權限~~ 已經查過了，不用做：Sheet 目前是「知道連結的人都能編輯」，服務帳號本來就在範圍內。（附帶一提：這代表整份 Sheet 任何人拿到連結都能編輯，不是只有特定帳號，如果不是故意這樣設的，可能要留意一下。）
3. **設定三把 secret**（在專案目錄下執行，不要寫進 wrangler.toml）：
   ```
   wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
   wrangler secret put INTERNAL_SYNC_SECRET
   ```
4. `wrangler.toml` 裡的 `GOOGLE_SHEET_ID` 已經填好（「2026-永平整復預約表」）。
5. `src/validate.js` 開頭註解提到的排班衝突判斷方式（同 slot 但顧客姓名不同才算真衝突），麻煩看一眼是否符合預期。
6. `npm install && npm run dev` 本機測，確認沒問題後 `npm run deploy`。

## 本機開發

```
npm install
npm test        # 跑所有單元測試（163 個，不需要任何真實憑證）
npm run dev      # wrangler dev 本機啟動（R2 預設用本機模擬，不會動到正式 bucket）
```
