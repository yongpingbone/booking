function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('🌟 永平專屬功能')
    .addItem('📈 統計黃底人數', 'countYellowBackgroundCells')
    .addToUi();
}

// ================= 黃底自動統計人數 =================
function countYellowBackgroundCells() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var ui = SpreadsheetApp.getUi();
  
  var range = sheet.getDataRange();
  var backgrounds = range.getBackgrounds();
  var values = range.getValues();
  
  var yellowCount = 0;
  var yellowNames = [];
  
  for (var i = 0; i < backgrounds.length; i++) {
    for (var j = 0; j < backgrounds[i].length; j++) {
      var bgColor = backgrounds[i][j].toLowerCase();
      var cellValue = String(values[i][j]).trim();
      
      if (bgColor === "#ffff00" && cellValue.length > 0) {
        yellowCount++;
        yellowNames.push(cellValue);
      }
    }
  }
  
  var uniqueNames = [...new Set(yellowNames)];
  
  var message = "📊 黃底統計結果\n\n";
  message += "總黃底數量: " + yellowCount + " 個\n";
  message += "獨立人數: " + uniqueNames.length + " 人\n\n";
  
  if (uniqueNames.length > 0) {
    message += "人名列表:\n" + uniqueNames.join("\n");
  }
  
  ui.alert(message);
}

// ═════════════════════════════════════════════════════════════
// 永平整復保健 - Sheet 編輯即時通知 Worker
// ═════════════════════════════════════════════════════════════
// 運作方式：編輯試算表任何一個月份分頁時，會排一個「延遲觸發」；如果
// 60 秒內又有新的編輯，延遲會往後重排(不會馬上觸發)；直到停止編輯滿
// 60 秒，才真的通知 Worker 去同步。這樣連續編輯一大段時間，也只會在
// 真正停手後觸發一次，不會每打一個字就打一次 API。
//
// 跟原本每 15 分鐘的排程是「兩條並行的路」，這個負責「幾乎即時」反應，
// 排程負責「保底」(就算這支程式故障、被停用，最多 15 分鐘還是會抓到)。
// 兩邊都會經過 Worker 自己的同步鎖保護，不會互相打架、不會同時疊著跑。
//
// ── 安裝方式(一次性設定，大概 2 分鐘) ──
//   1. 開啟這份試算表 → 上方選單「擴充功能」→「Apps Script」
//   2. 如果裡面已經有程式碼，先確認過沒有正在使用中的東西再整個取代；
//      不確定的話跟 Claude 說一聲，先確認過再繼續
//   3. 把這整份程式碼貼上去(取代原本的內容)，存檔(Ctrl+S / Cmd+S)
//   4. 上方工具列的函式下拉選單選「setupTrigger」，點旁邊的執行(▷)
//   5. 第一次執行會跳出「需要授權」的畫面，一路選「允許」到底
//      (這是 Google 的標準流程，因為這支程式需要讀取試算表內容、
//      對外發送通知，所以需要妳親自同意一次)
//   6. 執行完成、沒有紅色錯誤訊息，就代表設定好了，可以直接關掉這個分頁
// ═════════════════════════════════════════════════════════════

const WORKER_SYNC_URL = 'https://yongping-sheet-sync.yihanhsu123.workers.dev/sync';
const INTERNAL_SECRET = '2b837dea8d749031b47e5a2405f62cb4b09fffc931c8f2317a0b77ac0bbf86c1';
const DEBOUNCE_SECONDS = 60; // 停止編輯後等這麼久才觸發，可以自己調整這個數字
const PENDING_TRIGGER_ID_KEY = 'PENDING_SYNC_TRIGGER_ID';

/**
 * 一次性設定：建立「編輯時」的監聽器。執行這個函式一次就好，不用重複執行
 * (重複執行也不會出錯，會自動先清掉舊的再建立新的)。
 */
function setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'onSheetEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  Logger.log('設定完成。之後編輯任何「N月-XX」格式的分頁，停止編輯 ' + DEBOUNCE_SECONDS + ' 秒後會自動觸發同步。');
}

/**
 * 每次編輯試算表都會被呼叫，但這裡只負責「排一個延遲觸發」，不會每次
 * 編輯都真的去通知 Worker(不然打字打到一半就一直觸發，太浪費)。
 */
function onSheetEdit(e) {
  try {
    const sheetName = e.source.getActiveSheet().getName();
    // 只關心「N月-XX」格式的月份分頁，其他分頁(例如統計用途的)編輯
    // 不需要觸發同步。
    if (!/^\d{1,2}月-/.test(sheetName)) return;

    schedulePendingSync();
  } catch (err) {
    // 這裡萬一出錯，不該影響使用者正常編輯試算表，安靜記錄起來就好，
    // 不要跳出任何畫面干擾。
    Logger.log('onSheetEdit 發生錯誤: ' + err);
  }
}

/**
 * 把之前排的延遲觸發取消掉(如果有)，重新排一個新的——每次新編輯都會
 * 把觸發時間往後延，直到真的停手 DEBOUNCE_SECONDS 秒才會真的觸發。
 */
function schedulePendingSync() {
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty(PENDING_TRIGGER_ID_KEY);
  if (existingId) {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getUniqueId() === existingId) ScriptApp.deleteTrigger(t);
    });
  }
  const newTrigger = ScriptApp.newTrigger('firePendingSync')
    .timeBased()
    .after(DEBOUNCE_SECONDS * 1000)
    .create();
  props.setProperty(PENDING_TRIGGER_ID_KEY, newTrigger.getUniqueId());
}

/**
 * 真正通知 Worker 去同步——只有在停止編輯滿 DEBOUNCE_SECONDS 秒後才會
 * 被呼叫到。這個 time-based trigger 本身執行完，Apps Script 會自動清掉，
 * 不用手動處理。
 */
function firePendingSync() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PENDING_TRIGGER_ID_KEY);

  try {
    const res = UrlFetchApp.fetch(WORKER_SYNC_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      payload: JSON.stringify({ scope: 'current', background: true }),
      muteHttpExceptions: true,
    });
    Logger.log('觸發同步完成: HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
  } catch (err) {
    Logger.log('觸發同步失敗(下一次排程 15 分鐘內還是會自動抓到，不會漏資料): ' + err);
  }
}
