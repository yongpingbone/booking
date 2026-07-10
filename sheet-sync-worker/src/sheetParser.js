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
// - 顏色：黃底(#FFFF00)=新客(已確認)。紅底(#FF0000)=休假或不開放時段(Hanna
//   確認，預設當休假處理)，不是真正的顧客預約，但格子裡原本寫的文字還是
//   保留下來當備註，不會被覆蓋成固定文字。其他顏色(米色/白/透明/藍/青)
//   還是沒有規律、Hanna 也確認 Sheet 端沒有正式定義過，不猜。
// - 延續符號：同一格預約如果橫跨多個時段，後面時段會填一個「同格延續」符號
//   而不是重複打名字。四位師傅的符號都已確認：
//     麒 用 ”(U+201D)、泓文/哲瑋 用 ''(兩個直引號) —— 延續符號，自動合併同一筆
//     治 用 *，但意思不是延續，是「舊客預約、治不想打名字」(Hanna 確認)——
//       所以治的 "*" 會產生一筆獨立預約，customerName 填「舊客」佔位，
//       不會被誤判成延續符號
//
// - 師傅名字：Sheet 分頁用的是「泓文/哲瑋/麒/治」這種暱稱，但 Supabase
//   masters.name 存的是正式名字——已確認 麒=許老師、治=魏老師(泓文/哲瑋
//   本身就是正式名字，兩邊一致，不用轉換)。所以每筆記錄同時帶兩個師傅相關
//   欄位：masterName 是要拿去對 masters.name 用的正式名字，sheetMasterLabel
//   是這筆資料來源的分頁暱稱(sheetWriter.js 要用它反推分頁名稱寫回備註，
//   不能直接用 masterName，因為分頁不叫「7月-許老師」)。
//
// 目前所有已知符號/顏色/名字對照都確認過了，沒有還卡著的疑問。

import { serialToDateString, serialToTimeString } from './sheetsSerial.js';
import { buildIdentityKey, hashContent } from './diff.js';
import { getAccessToken as defaultGetAccessToken } from './googleAuth.js';
import { fetchGridRows as defaultFetchGridRows } from './sheetsApi.js';

const WEEKDAY_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const REF_ERROR_TEXT = '#REF!';
const SLOTS_PER_BLOCK = 30; // 8:00 ~ 22:30，每 30 分鐘一格
// 一個週區塊總共佔幾列："時間"表頭列(1) + 時段列(SLOTS_PER_BLOCK) + "人數"小計列(1) + 空白列(2)
const BLOCK_ROW_SPAN = 1 + SLOTS_PER_BLOCK + 1 + 2; // = 34
const ANONYMOUS_RETURNING_CUSTOMER_LABEL = '舊客';

// 底色 → color_tag，對照 booking repo 裡 app 自己用的 COLORS 分類命名，
// 這樣同步進來的資料跟 app 手動建立的資料在同一套分類底下。
// 只放「已確認」的兩種，其餘一律 'none'，不猜。
const COLOR_HEX_TO_TAG = {
  '#FFFF00': 'new_customer', // 已確認
  '#FF0000': 'vacation', // 已確認(Hanna：紅色默認休假，或者不開放時段)
};

// 目前看過、疑似是「延續符號」的完整集合(不代表每個 master 都用、也不代表意思確認過)。
// 只有出現在該 master.continuationMarks 清單裡才會真的自動合併成同一筆；
// 出現在這個集合裡、但既不在該 master 的 continuationMarks 也不在
// anonymousReturningCustomerMarks 清單裡 → 保留成獨立一筆，但標記 needsReview，
// 提醒有人要去確認這是不是新發現的符號用法。
const KNOWN_CONTINUATION_LIKE_SYMBOLS = ['\u201D', '\u201C', "''", '"', "'", '\u3003', '*'];

// name = Sheet 分頁命名用的暱稱；masterDbName = 要拿去對 Supabase masters.name
// 的正式名字。兩者不一樣時(麒/治)才需要特別列 masterDbName，一樣的話(泓文/哲瑋)
// 省略、下面的程式會自動 fallback 成 name。
const SHEET_MASTERS = [
  { name: '泓文', continuationMarks: ["''"], anonymousReturningCustomerMarks: [] },
  { name: '哲瑋', continuationMarks: ["''"], anonymousReturningCustomerMarks: [] }, // 已確認：跟泓文同一套
  { name: '麒', masterDbName: '許老師', continuationMarks: ['\u201D'], anonymousReturningCustomerMarks: [] },
  { name: '治', masterDbName: '魏老師', continuationMarks: [], anonymousReturningCustomerMarks: ['*'] },
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

        if (text === '') {
          delete ongoing[colIdx];
          continue;
        }

        const isConfirmedContinuation = master.continuationMarks.includes(text);
        if (isConfirmedContinuation && ongoing[colIdx]) {
          ongoing[colIdx].slotCount += 1;
          continue;
        }

        const isAnonymousReturningCustomer = (master.anonymousReturningCustomerMarks ?? []).includes(text);
        const colorTag = COLOR_HEX_TO_TAG[cellData.colorHex] ?? 'none';

        const record = {
          masterName: masterDbName,
          sheetMasterLabel: master.name,
          date,
          startTime,
          customerName: isAnonymousReturningCustomer ? ANONYMOUS_RETURNING_CUSTOMER_LABEL : text,
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
        gridResult = await doFetchGridRows(env, { sheetTitle, range: 'A1:H1010', accessToken });
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

export {
  parseGridIntoRecords,
  findBlockHeaderRows,
  buildWeekdayColumnMap,
  monthsSpannedByWeek,
  fetchAndParseWeek,
  SHEET_MASTERS,
  COLOR_HEX_TO_TAG,
  WEEKDAY_LABELS,
  SLOTS_PER_BLOCK,
  BLOCK_ROW_SPAN,
};
