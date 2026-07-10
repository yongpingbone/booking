// sheetParser.js
//
// 分頁結構(已對照真實的「2026-永平整復預約表」驗證過，不是用猜的)：
// - 一個月一個分頁，命名 "{N}月-{師傅名}"(N 不補零，例如 "7月-泓文")。另外
//   還有 "{N}月-合併"(泓文+哲瑋併排版)，內容跟兩人個別分頁完全一致(已用
//   真實資料逐格比對過)，所以只讀四個獨立分頁，不用管合併版。
// - 分頁第 1 列固定放「週日～週六」7 個標籤，決定每個 weekday 對應哪一欄，
//   整份分頁只出現這一次，不會每週重複。
// - 每個「週區塊」：第一列(A欄="時間")放這週實際日期(月初/月底跨到別月的
//   那幾欄會是空的，代表這欄這個區塊沒有日期)；接著 30 列是每半小時一格的
//   時段(8:00~22:30)；再來 1 列"人數"小計；再來 2 列空白，然後下一個「時間」
//   列開始下一週，反覆到月底。
// - 顏色(Hanna 確認的完整規則)：黃底(#FFFF00)=新客。紅底(#FF0000)=休假。
//   米黃(#FFF2CC)/白(#FFFFFF)單純是視覺分隔，沒有語意(尤其泓文/哲瑋的分頁
//   大量用米黃色分隔，不能誤判)。除了這幾個，只要格子有明確底色，一律當
//   自訂(custom)。
//   格子空白但底色有意義(休假/自訂)時，一樣要算一筆——不能因為沒打字就
//   跳過，不然像整塊標紅的休假時段會完全漏掉不會同步。空白色塊沒有文字
//   可以當姓名，比照 app 自己「選色標沒打名字時」的規則(休假→「休假」、
//   自訂→「自訂」)；連續好幾格都是同一種空白色塊時會合併成一筆
//   (slotCount 累加)，不會拆成好幾筆重複紀錄。
// - 延續符號：同一格預約如果橫跨多個時段，後面時段會填一個「同格延續」符號
//   而不是重複打名字。四位師傅的符號都已確認：
//     麒 用 ”(U+201D)、泓文/哲瑋 用 ''(兩個直引號) —— 延續符號，自動合併同一筆
//     治 用 *，但意思不是延續，是「舊客預約、治不想打名字」(Hanna 確認)——
//       所以治的 "*" 會產生一筆獨立預約，customerName 保留原始的 "*"(不翻
//       譯成別的字，見下面 parseGridIntoRecords 裡的說明)，不會被誤判成
//       延續符號
//
// - 師傅名字：已經用 SQL 直接查過 masters 表，name 欄位存的就是「泓文/哲瑋/
//   麒/治」這四個值本身，不是「許老師」「魏老師」這種正式稱呼——後面這兩個
//   說法只是平常口語怎麼稱呼這兩位師傅，不是系統裡的名字，資料庫裡完全查
//   不到。所以每筆記錄的 masterName / sheetMasterLabel 兩個欄位目前對這四位
//   師傅來說都是同一個值(見 SHEET_MASTERS 的 masterDbName 說明)。
//
// 目前所有已知符號/顏色/名字對照都確認過了(而且是真的查證過，不是猜的)，
// 沒有還卡著的疑問。

import { serialToDateString, serialToTimeString } from './sheetsSerial.js';
import { buildIdentityKey, hashContent } from './diff.js';
import { getAccessToken as defaultGetAccessToken } from './googleAuth.js';
import { fetchGridRows as defaultFetchGridRows } from './sheetsApi.js';

const WEEKDAY_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const REF_ERROR_TEXT = '#REF!';
const SLOTS_PER_BLOCK = 30; // 8:00 ~ 22:30，每 30 分鐘一格
// 一個週區塊總共佔幾列："時間"表頭列(1) + 時段列(SLOTS_PER_BLOCK) + "人數"小計列(1) + 空白列(2)
const BLOCK_ROW_SPAN = 1 + SLOTS_PER_BLOCK + 1 + 2; // = 34

// 底色 → color_tag，對照 booking repo 裡 app 自己用的 COLORS 分類命名，
// 這樣同步進來的資料跟 app 手動建立的資料在同一套分類底下。
// 分類規則(Hanna 確認)：紅=休假、黃=新客、米黃/白(單純用來分隔、沒有語意)
// =none、其他任何有明確底色的一律當自訂。
const COLOR_HEX_TO_TAG = {
  '#FFFF00': 'new_customer', // 已確認
  '#FF0000': 'vacation', // 已確認(Hanna：紅色=休假)
};
// 這些顏色純粹是視覺分隔用，沒有語意——尤其泓文/哲瑋的分頁大量用米黃色
// 做區隔，不能被下面的「其他顏色=自訂」規則掃進去，不然會把大量正常預約
// 誤標成自訂。
const NEUTRAL_COLOR_HEXES = new Set(['#FFFFFF', '#FFF2CC']);
// 空白但底色有意義時(休假/自訂)，沒有文字內容可以當 customerName，比照
// app 自己「選色標沒打名字時」的既有規則(booking repo COLOR_DEFAULT_NAMES)。
const COLOR_DEFAULT_NAMES = { vacation: '休假', custom: '自訂' };

/**
 * @param {string|null} colorHex
 * @returns {'new_customer'|'vacation'|'custom'|'none'}
 */
function resolveColorTag(colorHex) {
  if (!colorHex) return 'none';
  if (NEUTRAL_COLOR_HEXES.has(colorHex)) return 'none';
  if (COLOR_HEX_TO_TAG[colorHex]) return COLOR_HEX_TO_TAG[colorHex];
  return 'custom'; // 不是中性色、也不是已知的黃/紅 → 一律當自訂，不再視為沒有意義
}

// 目前看過、疑似是「延續符號」的完整集合(不代表每個 master 都用、也不代表意思確認過)。
// 只有出現在該 master.continuationMarks 清單裡才會真的自動合併成同一筆；
// 出現在這個集合裡、但既不在該 master 的 continuationMarks 也不在
// anonymousReturningCustomerMarks 清單裡 → 保留成獨立一筆，但標記 needsReview，
// 提醒有人要去確認這是不是新發現的符號用法。
const KNOWN_CONTINUATION_LIKE_SYMBOLS = ['\u201D', '\u201C', "''", '"', "'", '\u3003', '*'];

// 已經用 SQL 查證過 masters.name 直接存「麒/治/泓文/哲瑋」這四個值本身，
// 沒有「許老師」「魏老師」這種正式稱呼存在資料庫任何地方——那兩個名字只是
// 平常口語稱呼，不是系統裡的正式名字。之前一度誤加了 masterDbName 轉換
// (麒→許老師、治→魏老師)，導致這兩位師傅的預約全部「找不到師傅」失敗，
// 已經移除。四位師傅的 masterName 現在都直接等於 Sheet 分頁暱稱本身，不用
// 再轉換；masterDbName 這個機制保留著、只是目前沒有任何 master 需要用到，
// 如果之後真的有名字對不上的狀況，直接在對應的物件加回 masterDbName 就好。
const SHEET_MASTERS = [
  { name: '泓文', continuationMarks: ["''"], anonymousReturningCustomerMarks: [] },
  { name: '哲瑋', continuationMarks: ["''"], anonymousReturningCustomerMarks: [] }, // 已確認：跟泓文同一套
  { name: '麒', continuationMarks: ['\u201D'], anonymousReturningCustomerMarks: [] },
  { name: '治', continuationMarks: [], anonymousReturningCustomerMarks: ['*'] },
];

/**
 * @param {Array<Array<{value: any, colorHex: string|null}>>} rows
 * @returns {Record<number, number>} weekday(0=週日..6=週六) -> colIndex
 */
function buildWeekdayColumnMap(rows) {
  const headerRow = rows[0] ?? [];
  const map = {};
  headerRow.forEach((c, idx) => {
    const wd = WEEKDAY_LABELS.indexOf(c?.value);
    if (wd !== -1) map[wd] = idx;
  });
  if (Object.keys(map).length !== 7) {
    throw new Error(`第 1 列找不到完整的「週日～週六」7 個標籤，只找到 ${Object.keys(map).length} 個`);
  }
  return map;
}

/**
 * @param {Array<Array<{value: any, colorHex: string|null}>>} rows
 * @returns {number[]} 每個週區塊「時間」表頭列所在的 row index
 */
function findBlockHeaderRows(rows) {
  const indices = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r]?.[0]?.value === '時間') indices.push(r);
  }
  return indices;
}

function isKnownContinuationLikeSymbol(text) {
  return KNOWN_CONTINUATION_LIKE_SYMBOLS.includes(text);
}

/**
 * 把單一師傅、單一分頁的完整格子資料解析成 BookingRecord[]。
 * @param {Array<Array<{value: any, colorHex: string|null}>>} rows sheetsApi.fetchGridRows() 的 rows
 * @param {{name: string, continuationMarks: string[]}} master
 * @returns {Promise<Array<object>>}
 */
async function parseGridIntoRecords(rows, master) {
  const masterDbName = master.masterDbName ?? master.name;
  const weekdayCols = buildWeekdayColumnMap(rows);
  const headerRows = findBlockHeaderRows(rows);
  const records = [];

  for (const headerRow of headerRows) {
    const dateRow = rows[headerRow] ?? [];
    const dateByCol = {};
    for (const colIdx of Object.values(weekdayCols)) {
      const serial = dateRow[colIdx]?.value;
      if (serial != null && serial !== '') dateByCol[colIdx] = serialToDateString(serial);
    }

    const totalRowIdx = headerRow + 1 + SLOTS_PER_BLOCK;
    const totalRow = rows[totalRowIdx];
    if (!totalRow || totalRow[0]?.value !== '人數') {
      throw new Error(`週區塊(表頭在第 ${headerRow} 列)結構跟預期不符：第 ${totalRowIdx} 列應該是「人數」小計列，實際是 ${JSON.stringify(totalRow?.[0]?.value)}`);
    }

    const ongoing = {}; // colIndex -> 目前正在累積延續格的 record

    for (let slot = 0; slot < SLOTS_PER_BLOCK; slot++) {
      const r = headerRow + 1 + slot;
      const timeSerial = rows[r]?.[0]?.value;
      const startTime = serialToTimeString(timeSerial);

      for (const colIdxStr of Object.keys(dateByCol)) {
        const colIdx = Number(colIdxStr);
        const date = dateByCol[colIdx];
        const cellData = rows[r]?.[colIdx] ?? { value: null, colorHex: null };
        const text = cellData.value == null ? '' : String(cellData.value).trim();
        const colorTag = resolveColorTag(cellData.colorHex);

        if (text === '') {
          if (colorTag === 'none') {
            delete ongoing[colIdx];
            continue;
          }
          // 空白但底色有意義(休假/自訂)：這種整塊色塊沒有文字可以延續判斷，
          // 用「上一格是不是同一種空白色塊」來判斷要合併還是開新的一筆。
          const runningBlock = ongoing[colIdx];
          if (runningBlock?.isBlankColorBlock && runningBlock.colorTag === colorTag) {
            runningBlock.slotCount += 1;
            continue;
          }
          const record = {
            masterName: masterDbName,
            sheetMasterLabel: master.name,
            date,
            startTime,
            customerName: COLOR_DEFAULT_NAMES[colorTag] ?? colorTag,
            colorTag,
            isNewCustomer: false,
            slotCount: 1,
            needsReview: false,
            reviewReasons: [],
            isBlankColorBlock: true, // 內部用，判斷能不能被下一格同色空白延續；不會寫進 DB
          };
          records.push(record);
          ongoing[colIdx] = record;
          continue;
        }

        const isConfirmedContinuation = master.continuationMarks.includes(text);
        if (isConfirmedContinuation && ongoing[colIdx]) {
          ongoing[colIdx].slotCount += 1;
          continue;
        }

        const isAnonymousReturningCustomer = (master.anonymousReturningCustomerMarks ?? []).includes(text);

        const record = {
          masterName: masterDbName,
          sheetMasterLabel: master.name,
          date,
          startTime,
          customerName: text, // 不翻譯成「舊客」之類的可讀標籤——實測發現資料庫裡
          // 既有的 治 的「舊客不打名字」預約，customer_name 存的就是原始符號
          // 本身(例如 "*")，不是翻譯過的文字。翻譯過會導致跟既有資料庫紀錄的
          // customer_name 對不起來，被 validate.js 的排班衝突判斷誤判成
          // 「這是不同一筆」，明明是同一筆卻被擋下來。保持原始文字，兩邊才會一致。
          colorTag,
          isNewCustomer: colorTag === 'new_customer',
          slotCount: 1,
          needsReview: false,
          reviewReasons: [],
        };

        if (text === REF_ERROR_TEXT) {
          record.needsReview = true;
          record.reviewReasons.push('內容是壞掉的公式參照(#REF!)，可能是原本參照的列/儲存格被刪除，需要人工確認');
        } else if (isConfirmedContinuation && !ongoing[colIdx]) {
          // 延續符號出現，但前面沒有正在累積中的紀錄可以延續(例如區塊第一格就是延續符號)
          record.needsReview = true;
          record.reviewReasons.push(`內容是 ${master.name} 已確認的延續符號「${text}」，但前一格是空的，沒有東西可以延續，需要人工確認`);
        } else if (!isConfirmedContinuation && !isAnonymousReturningCustomer && isKnownContinuationLikeSymbol(text)) {
          record.needsReview = true;
          record.reviewReasons.push(`內容「${text}」看起來像延續或特殊符號，但不在 ${master.name} 已確認的清單裡，先當一般內容處理，需要人工確認是否為新發現的符號用法`);
        }

        records.push(record);
        ongoing[colIdx] = record;
      }
    }
  }

  for (const record of records) {
    record.identityKey = buildIdentityKey({ masterName: record.masterName, date: record.date, startTime: record.startTime });
    record.contentHash = await hashContent({
      customerName: record.customerName,
      colorTag: record.colorTag,
      slotCount: record.slotCount,
    });
  }

  return records;
}

/**
 * @param {string} weekKey "YYYY-MM-DD"(週一)
 * @returns {{year: number, month: number}[]} 由舊到新排序
 */
function monthsSpannedByWeek(weekKey) {
  const start = new Date(`${weekKey}T12:00:00Z`);
  const seen = new Set();
  const months = [];
  for (let offset = 0; offset < 7; offset++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + offset);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const key = `${year}-${month}`;
    if (!seen.has(key)) {
      seen.add(key);
      months.push({ year, month });
    }
  }
  return months;
}

/**
 * @param {string} weekKey
 * @returns {string[]} 這週 7 天的 "YYYY-MM-DD"
 */
function weekDateStrings(weekKey) {
  const start = new Date(`${weekKey}T12:00:00Z`);
  const dates = [];
  for (let offset = 0; offset < 7; offset++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + offset);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * @param {object} env 需要 env.GOOGLE_SERVICE_ACCOUNT_JSON、env.GOOGLE_SHEET_ID
 * @param {string} weekKey 見 weekKeys.js
 * @param {object} [deps] 測試用依賴注入：{ getAccessToken, fetchGridRows }
 * @returns {Promise<Array<object>>}
 */
async function fetchAndParseWeek(env, weekKey, deps = {}) {
  const doGetAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  const doFetchGridRows = deps.fetchGridRows ?? defaultFetchGridRows;

  const months = monthsSpannedByWeek(weekKey);
  const accessToken = await doGetAccessToken(env);

  const allRecords = [];
  for (const master of SHEET_MASTERS) {
    for (const { month } of months) {
      const sheetTitle = `${month}月-${master.name}`;
      let gridResult;
      try {
        // 一個月最多 6 個週區塊(header 1 列 + 6*34 = 205 列)，抓 260 列留寬裕
        // 空間；原本抓到 1010 列，一個月分頁其實用不到那麼多，白白增加資料量
        // 跟解析時間。
        gridResult = await doFetchGridRows(env, { sheetTitle, range: 'A1:H260', accessToken });
      } catch (err) {
        throw new Error(`讀取分頁「${sheetTitle}」失敗: ${err.message}`);
      }
      const records = await parseGridIntoRecords(gridResult.rows, master);
      allRecords.push(...records);
    }
  }

  const targetDates = new Set(weekDateStrings(weekKey));
  return allRecords.filter((r) => targetDates.has(r.date));
}

/**
 * 抓一整個月、四位師傅全部的記錄(不像 fetchAndParseWeek 只篩一週)。
 * 目前只有 reconcile.js 的一次性月份校正功能會用到，平常排程走的還是
 * fetchAndParseWeek。
 * @param {object} env
 * @param {number} year
 * @param {number} month 1-12
 * @param {object} [deps]
 * @returns {Promise<Array<object>>}
 */
async function fetchAndParseMonth(env, year, month, deps = {}) {
  const doGetAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  const doFetchGridRows = deps.fetchGridRows ?? defaultFetchGridRows;

  const accessToken = await doGetAccessToken(env);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

  const allRecords = [];
  for (const master of SHEET_MASTERS) {
    const sheetTitle = `${month}月-${master.name}`;
    let gridResult;
    try {
      gridResult = await doFetchGridRows(env, { sheetTitle, range: 'A1:H260', accessToken });
    } catch (err) {
      throw new Error(`讀取分頁「${sheetTitle}」失敗: ${err.message}`);
    }
    const records = await parseGridIntoRecords(gridResult.rows, master);
    // 分頁裡的週區塊可能帶到鄰月的日期(跨月那週)，只留真的屬於這個月的
    allRecords.push(...records.filter((r) => r.date.startsWith(monthPrefix)));
  }
  return allRecords;
}

export {
  parseGridIntoRecords,
  findBlockHeaderRows,
  buildWeekdayColumnMap,
  monthsSpannedByWeek,
  fetchAndParseWeek,
  fetchAndParseMonth,
  SHEET_MASTERS,
  COLOR_HEX_TO_TAG,
  NEUTRAL_COLOR_HEXES,
  resolveColorTag,
  WEEKDAY_LABELS,
  SLOTS_PER_BLOCK,
  BLOCK_ROW_SPAN,
};
