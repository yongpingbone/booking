function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('🌟 永平專屬功能')
    .addItem('📊 產生師傅客情與回頭率報表', 'generateCustomerReport')
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

function getEditDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  var matrix = [];
  for (var i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (var j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (var i = 1; i <= b.length; i++) {
    for (var j = 1; j <= a.length; j++) {
      if (b.charAt(i-1) === a.charAt(j-1)) {
        matrix[i][j] = matrix[i-1][j-1];
      } else {
        matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, Math.min(matrix[i][j-1] + 1, matrix[i-1][j] + 1));
      }
    }
  }
  return matrix[b.length][a.length];
}

function generateCustomerReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  ui.alert('⏳ 系統開始運算...', '正在過濾電話號碼並載入最新合併名單，請稍候 3~5 秒！', ui.ButtonSet.OK);

  var sheets = ss.getSheets();
  var ignoreWords = ["手機版更新", "休", "滿", "時間", "師傅", "人數", "新客", "每日新客", "每週人數", "早上", "下午", "晚上", "非營業", "請假", "排休", "無", "週一", "週二", "週三", "週四", "週五", "週六", "週日", "星期", "姓名", "日期", "客源", "項目", "金額", "備註", "合計", "總計", "打掃", "#REF!", "#N/A", "#VALUE!", "#NAME?", "FALSE", "TRUE"];
  
  var customerData = { "泓文": {}, "哲瑋": {} };

  var nameCorrections = {
    "馮信維": "馮信雄",
    "丁啓展": "丁啟展",
    "吳佑賓": "吳祐賓",
    "林啓珉": "林啟珉",
    "吳昌祐": "吳昌佑",
    "陳毓燻": "陳毓薰",
    "蔡珮金": "蔡佩金",
    "蔡銘祐": "蔡銘佑",
    "趙翊玟": "趙翊妏",
    "林裔宸": "林依宸",
    "林伊宸": "林依宸",
    "陳俊瑋": "陳俊偉",
    "郭凡瑜": "郭凡渝",
    "許淑楨": "許淑真",
    "許淑禎": "許淑真",
    "王威澄/": "王威澄",
    "曾翌嘉": "曾翊嘉",
    "曾羿嘉": "曾翊嘉",
    "施宣泛": "施宣汎",
    "周姵如": "周珮如",
    "尤利敏": "尤俐敏",
    "Clair曾": "Claire曾",
    "廖憶珊": "廖億珊",
    "陳嘉曼": "陳嘉蔓"
  };

  // ================= 1. 資料清洗與載入 =================
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    var sName = sheet.getName();
    
    var dedicatedMaster = "";
    if (sName.indexOf("月-泓文") !== -1) dedicatedMaster = "泓文";
    else if (sName.indexOf("月-哲瑋") !== -1 || sName.indexOf("月-哲緯") !== -1) dedicatedMaster = "哲瑋";

    if (dedicatedMaster === "") continue;

    var data = sheet.getDataRange().getValues();
    var numRows = data.length, numCols = data[0].length;
    var lastValidNamePerCol = {}; 

    for (var r = 0; r < numRows; r++) {
      for (var c = 0; c < numCols; c++) {
        var cellData = data[r][c];
        
        if (cellData instanceof Date || typeof cellData === 'object') {
            lastValidNamePerCol[c] = null;
            continue; 
        }

        var rawName = String(cellData).trim();
        var cleanName = rawName.replace(/\s+/g, ""); 
        
        if (!cleanName) {
            lastValidNamePerCol[c] = null;
            continue;
        }
        
        if (cleanName === '"' || cleanName === '"' || cleanName === '"' || cleanName === '〃' || cleanName === "''") {
            if (lastValidNamePerCol[c]) {
                cleanName = lastValidNamePerCol[c]; 
            } else {
                continue; 
            }
        }

        if (cleanName.length > 15 || cleanName.length < 2) {
            lastValidNamePerCol[c] = null;
            continue; 
        }
        if (cleanName === "麒" || cleanName === "泓文" || cleanName === "哲瑋" || cleanName === "哲緯" || cleanName === "治") {
            lastValidNamePerCol[c] = null;
            continue; 
        }
        
        var isTimeOrNumber = /[0-9:：/]/.test(cleanName) && cleanName.length <= 5; 
        var isIgnore = false;
        
        for(var i=0; i<ignoreWords.length; i++){
          if(cleanName.indexOf(ignoreWords[i]) !== -1) {
            if (ignoreWords[i].length >= 3) isIgnore = true; 
            else if (cleanName.length <= 5) isIgnore = true; 
          }
        }
        
        if (!isTimeOrNumber && !isIgnore) {
          var mergedName = cleanName
            .replace(/右手肘開刀2年/g, "") 
            .replace(/[\(（【\[].*?[\)）】\]]/g, "") 
            .replace(/[，。、,\.\-\_🔄'\'\""'\/]+/g, "") 
            .replace(/[0-9\-]+$/, ""); 
            
          var phoneMatch = mergedName.match(/^([0-9]+)(.+)$/);
          if (phoneMatch) {
              mergedName = phoneMatch[2]; 
          }

          if (mergedName.length < 2) {
              lastValidNamePerCol[c] = null;
              continue; 
          }
          
          lastValidNamePerCol[c] = cleanName; 

          if (nameCorrections[mergedName]) {
              mergedName = nameCorrections[mergedName];
          }

          var keyName = mergedName.toUpperCase();

          if (!customerData[dedicatedMaster][keyName]) {
             customerData[dedicatedMaster][keyName] = { count: 0, display: mergedName };
          }
          customerData[dedicatedMaster][keyName].count++;
        } else {
          lastValidNamePerCol[c] = null;
        }
      }
    }
  }

  // ================= 2. 產出報表設定 =================
  var sheetNameOthers = "📊 泓文&哲瑋-客情分析";

  function setupReportSheet(sheetName) {
    var reportSheet = ss.getSheetByName(sheetName);
    if (reportSheet) ss.deleteSheet(reportSheet); 
    reportSheet = ss.insertSheet(sheetName, 0); 
    
    reportSheet.appendRow([
      "師傅", "總服務人次", "獨立客數 (去重複)", "回頭率 (>2次)", 
      "💔 流失率 (只來1次)", "🔥 鐵粉比例 (>=15次)", "🔥 鐵粉名單 (>=15次)", 
      "⚠️ 疑似打錯的相似名字", "🔍 只來1次名單 (請核對打錯)"
    ]);
    reportSheet.getRange("A1:I1").setBackground("#85200c").setFontColor("white").setFontWeight("bold").setHorizontalAlignment("center");
    return reportSheet;
  }

  var sheetOthers = setupReportSheet(sheetNameOthers);

  var reportGroups = [
    { masters: ["泓文", "哲瑋"], sheet: sheetOthers }
  ];

  var knownDiff = [
    "黃莉云|黃莉儒", "徐梓如|徐穎如", "李佳芸|李佳紋", "李佳芸|李佳芮", 
    "EMILY|AMILY", "EMILY|大榮EMILY", "陳SFIONA|陳S", "曉鳳姐|曉鳳姊", 
    "莊大嫂|莊大哥", "黃R|黃R木工", "蕭以弦|蕭以筑", "陳明儒|陳鼎儒", "AMILY許|AMILY",
    "黃于真|黃于寰", "陳韋文|陳韋臻", "黃建鎮|黃建豪", "林淑涓|林淑瑤",
    "林金生|林金元", "林金生|林先生", "李佳紋|李佳芮",
    "李宗諺|李宗信", "李佩芳|李佩芸", "邱彥翔|邱彥勝", "陳小姐|陳小萍",
    "張S|張SKELLY", "張淑雯|張茗雯", "吳先生|吳先生（東山鴨頭", "林啓弘|林啓抿",
    "吳泓緯|吳冠緯", "陳羿蓉|陳宥蓉", "BRYANT楊|RYA", "張聖浩|張奕浩",
    "林幸穎|林青穎", "林湘凌|林婉凌", "黃建智|黃建禾", "簡建昌|簡名昌",
    "PEI|WEI", "陳俊宏|陳建宏", "林弘凱|林靖凱", "陳建宏|陳建崴",
    "陳人豪|陳思豪", "張瑞業|張志業", "張瑞業|張瑞紜", "陳冠涵|陳冠仲",
    "張嘉庭|張嘉婷", "林育詩|林育瑞", "賴怡婷|賴怡君", "林宣廷|林瑋廷",
    "黃詩芸|黃詩涵", "黃怡瑄|黃怡蓉", "李哲瑋|李哲逸", "陳政霖|陳楷霖",
    "黃S|黃SH", "陳彥名|陳彥華", "張家宏|張家瑜", "李田心|李允心",
    "陳思翰|陳思豪", "黃怡蓉|黃怡宣",
    "黃玉華|黃玉瑩", "陳小如|陳小姐", "陳俊瑋|陳俊斌", "黃禎禎|黃品禎",
    "王群丞|王群英", "王群丞|王群承", "GRACE蘇|GRACE", "NICOLE|NICOLE張",
    "王群英|王群承", "王小姐|王小芳", "陳俊斌|陳俊偉", "楊美瑜|楊美真",
    "SANDY|MANDY", "謝佳欣|謝佳芸", "張碧羨|張畢羨", "胡思怡|胡思安",
    "簡士翔|簡士傑", "李先生|李櫪生", "陳鈺淨|陳鈺晴", "楊雅淳|楊雅慧",
    "王威澄|王威霖", "吳小泡|吳小姐", "JENNY|JENNY王", "陳慶龍|陳慶鴻",
    "謝小賢|謝小姐", "陳玟庭|陳玟廷", "星業務|星業務LEO", 
    "陳珮吟|陳佩吟", "彭慧潔|彭慧絜", "陳明修|陳明儒",
    "吳舟台|吳舟華", "林啓弘|林啓珉", "吳姵蓉|吳毓蓉", "林名儒|林明儒", "李郁喬|李郁玲",
    "NITA|ANITA黃", "CLAIRE母|CLAIR曾", "CLAIRE母|CLAIRE曾", "RITA|NITA"
  ];

  for (var g = 0; g < reportGroups.length; g++) {
    var targetMasters = reportGroups[g].masters;
    var currentSheet = reportGroups[g].sheet;

    for (var m = 0; m < targetMasters.length; m++) {
      var master = targetMasters[m];
      var namesDict = customerData[master];
      var uniqueKeys = Object.keys(namesDict);
      
      var totalUniqueCustomers = uniqueKeys.length; 
      var totalVisits = 0; 
      var returnCustomers = 0; 
      var loyalCustomers = 0;  
      var oneTimeCustomers = 0; 
      var loyalList = [];
      var oneTimeList = []; 
      
      for (var i = 0; i < uniqueKeys.length; i++) {
        var key = uniqueKeys[i];
        var count = namesDict[key].count;
        var dispName = namesDict[key].display;

        totalVisits += count; 

        if (count > 2) returnCustomers++;
        if (count === 1) { 
          oneTimeCustomers++;
          oneTimeList.push(dispName);
        }
        
        if (count >= 15) {
          loyalCustomers++;
          loyalList.push(dispName + " (" + count + "次)");
        }
      }

      var returnRate = totalUniqueCustomers > 0 ? ((returnCustomers / totalUniqueCustomers) * 100).toFixed(1) + "%" : "0%";
      var churnRate = totalUniqueCustomers > 0 ? ((oneTimeCustomers / totalUniqueCustomers) * 100).toFixed(1) + "%" : "0%"; 
      
      var loyalRateNum = totalUniqueCustomers > 0 ? ((loyalCustomers / totalUniqueCustomers) * 100).toFixed(1) : 0;
      var loyalText = loyalRateNum + "%";
      
      if (loyalCustomers > 0) {
        var ratio = Math.round(totalUniqueCustomers / loyalCustomers);
        loyalText += "\n\n(大約每 " + ratio + " 人\n就有 1 位鐵粉)";
      } else {
        loyalText += "\n\n(目前尚無 >=15次 鐵粉)";
      }

      loyalList.sort(function(a, b) { return parseInt(b.match(/\d+/)[0]) - parseInt(a.match(/\d+/)[0]); });
      oneTimeList.sort();

      var similarNamesList = [];
      var suffixes = ["姨丈", "學生", "老闆", "客人", "弟媳", "小弟", "媽", "爸", "公", "婆", "老公", "老婆", "先生", "小姐", "太太", "朋友", "兒", "女兒", "女", "家人", "同事", "大阿姨", "阿姨", "叔叔", "哥", "大哥", "姐", "姊", "大姊", "大嫂", "弟", "妹", "友", "男友", "女友", "長輩", "母", "父", "兄", "大姑", "嫂", "伯", "嬸", "侄", "侄子", "叔", "R", "S", "代", "妻", "木工"];
      
      function splitSuffix(n) {
        for (var k=0; k<suffixes.length; k++) {
          var suf = suffixes[k].toUpperCase();
          if (n.length > suf.length && n.substring(n.length - suf.length) === suf) {
            return { base: n.substring(0, n.length - suf.length), suffix: suf };
          }
        }
        return { base: n, suffix: "" };
      }

      for (var i = 0; i < uniqueKeys.length; i++) {
        for (var j = i + 1; j < uniqueKeys.length; j++) {
          var name1 = uniqueKeys[i]; 
          var name2 = uniqueKeys[j];
          var disp1 = namesDict[name1].display;
          var disp2 = namesDict[name2].display;

          if (name1.length === 1 || name2.length === 1) continue;

          var pairKey1 = name1 + "|" + name2;
          var pairKey2 = name2 + "|" + name1;
          if (knownDiff.indexOf(pairKey1) !== -1 || knownDiff.indexOf(pairKey2) !== -1) continue;

          var isCh1 = /[\u4e00-\u9fa5]/.test(name1[0]);
          var isCh2 = /[\u4e00-\u9fa5]/.test(name2[0]);
          if (isCh1 && isCh2 && name1[0] !== name2[0]) continue; 

          var part1 = splitSuffix(name1);
          var part2 = splitSuffix(name2);
          
          if (part1.base === part2.base && part1.suffix !== part2.suffix) continue;
          if (part1.suffix === part2.suffix && part1.suffix !== "" && part1.base !== part2.base) continue;

          var isRelative = false;
          if (name1.indexOf(name2) !== -1) {
               var diff = name1.replace(name2, "");
               for(var k=0; k<suffixes.length; k++) { if(diff.indexOf(suffixes[k].toUpperCase()) !== -1) isRelative = true; }
          } else if (name2.indexOf(name1) !== -1) {
               var diff = name2.replace(name1, "");
               for(var k=0; k<suffixes.length; k++) { if(diff.indexOf(suffixes[k].toUpperCase()) !== -1) isRelative = true; }
          }
          if (isRelative) continue;

          var isSimilar = false;
          if (name1.indexOf(name2) !== -1 || name2.indexOf(name1) !== -1) {
              isSimilar = true;
          } else {
              var distance = getEditDistance(name1, name2);
              if (distance === 1 && name1.length >= 3 && name2.length >= 3) {
                  isSimilar = true; 
              }
          }

          if (isSimilar) {
            similarNamesList.push(disp1 + " ↔ " + disp2);
          }
        }
      }

      currentSheet.appendRow([
        master,
        totalVisits + " 人次",
        totalUniqueCustomers + " 人",
        returnRate,
        churnRate, 
        loyalText, 
        loyalList.length > 0 ? loyalList.join("\n") : "尚無",
        similarNamesList.length > 0 ? similarNamesList.join("\n") : "無",
        oneTimeList.length > 0 ? oneTimeList.join("\n") : "無" 
      ]);
    }

    currentSheet.setColumnWidth(1, 80);
    currentSheet.setColumnWidth(2, 100);
    currentSheet.setColumnWidth(3, 120);
    currentSheet.setColumnWidth(4, 150);
    currentSheet.setColumnWidth(5, 150); 
    currentSheet.setColumnWidth(6, 180); 
    currentSheet.setColumnWidth(7, 250);
    currentSheet.setColumnWidth(8, 250); 
    currentSheet.setColumnWidth(9, 300); 
    currentSheet.getRange(2, 1, 4, 9).setVerticalAlignment("top"); 
    currentSheet.getRange(2, 5, 4, 5).setWrap(true); 
    
    var lastRow = currentSheet.getLastRow();
    if (lastRow > 1) {
       currentSheet.setRowHeights(2, lastRow - 1, 150); 
    }
  }
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
