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
//   自訂→「自訂」)。每一格都各自獨立一筆，不合併(原本會合併成一筆、
//   slotCount 累加，Hanna 看過實際畫面後不喜歡，改成每格獨立，這樣也
//   跟同行者那次的修正一致，避免同一種「合併後單一格對不到」的風險)。
// - 延續符號：一度誤以為代表「同一人療程比較長」，直接查證 app 自己建立
//   預約的程式碼(index.html 的 guestsNum>1 那段)後發現理解錯了——真正的
//   意思是「多位同行客人、同師傅、連續時段各佔一格」，app 自己的資料也是
//   每人各一列，customerName 是「原名-同行」(剛好2人)或「原名-同行1/2/3..」
//   (超過2人才編號，從1開始，對齊 app 的 for(let i=1;i<guestsNum;i++))。
//   四位師傅的符號都已確認：
//     麒 用 ”(U+201D)、泓文/哲瑋 用 ''(兩個直引號) —— 延續符號，
//       產生獨立的同行者記錄(不是合併成一筆、slotCount 不會累加)
//     治 用 *，但意思完全不是延續，是「舊客預約、治不想打名字」(Hanna 確認)——
//       所以治的 "*" 會產生一筆獨立預約，customerName 保留原始的 "*"(不翻
//       譯成別的字，見下面 parseGridIntoRecords 裡的說明)，不會被誤判成
//       延續符號
//   ⚠️ 這裡曾經合併成一筆(slotCount 累加)，導致同行者在資料庫裡對應的既有
//   預約，被一次性的 reconcile-month 校正功能誤判成「Sheet 上找不到對應」
//   而錯誤標記取消——這是真的發生過的事故。修正後每位同行者都是獨立記錄，
//   有自己的 identityKey，不會再被漏掉。
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
import { fetchSyncEnabledMasterNames as defaultFetchSyncEnabledMasterNames } from './supabaseClient.js';

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
const COLOR_DEFAULT_NAMES = { vacation: '休假', custom: '自訂', cui: '脆' };

// 「(脆)」「（脆）」是Hanna在Sheet上手動打在客人名字後面的文字慣例(不是靠
// 底色分辨)，例如「蔡孟奇（脆）」。匯入時要偵測到就從名字裡拿掉這段文字、
// 改成獨立的color_tag='cui'，不能讓「(脆)」原始文字留在customer_name裡
// (2026-07-13 Hanna 需求)。全形「（）」跟半形「()」都要認得。這個標記
// 代表的是文字本身，跟底色resolveColorTag()是兩套完全獨立的判斷依據；
// 一旦偵測到文字標記，優先權蓋過底色判斷的結果(Hanna手動打字比儲存格
// 底色更明確、更有意圖)。
const CUI_MARKER_RE = /[（(]脆[）)]/;
function extractCuiMarker(text) {
  if (!CUI_MARKER_RE.test(text)) return { cleanedText: text, isCui: false };
  return { cleanedText: text.replace(CUI_MARKER_RE, '').trim(), isCui: true };
}

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
// sourceMode: 'merged' 的師傅要從「{月}月-合併」(泓文+哲瑋併排版)分頁讀取，
// 不是自己的「{月}月-{名字}」個別分頁——查證過兩份分頁的顏色/內容其實
// 不一致(Hanna 截圖確認合併分頁上有實際在用的黃底新客標記，但個別分頁
// 完全沒有)，Hanna 明確要求泓文/哲瑋以合併分頁為準、麒/治維持個別分頁。
const SHEET_MASTERS = [
  { name: '泓文', continuationMarks: ["''"], anonymousReturningCustomerMarks: [], sourceMode: 'merged' },
  { name: '哲瑋', continuationMarks: ["''"], anonymousReturningCustomerMarks: [], sourceMode: 'merged' }, // 已確認：跟泓文同一套
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
 * 處理某一個時段列、某組欄位對應到的日期，把符合規則的記錄推進 records
 * 裡，並更新 ongoing 追蹤延續符號的狀態。個別分頁跟合併分頁共用這支，
 * 差別只在「要處理哪幾欄、每欄對應到哪個日期」的算法不同——這樣兩種
 * 分頁格式的業務規則(延續符號、顏色、#REF! 等)保證完全一致，不會有
 * 改一邊忘記改另一邊的風險。
 * @param {object} params
 * @param {Array<Array<{value: any, colorHex: string|null}>>} params.rows
 * @param {number} params.r 這個時段列的 row index
 * @param {string} params.startTime
 * @param {Record<number, string>} params.colDateMap colIdx -> "YYYY-MM-DD"
 * @param {{name: string, continuationMarks: string[], anonymousReturningCustomerMarks?: string[], masterDbName?: string}} params.master
 * @param {Record<number, object>} params.ongoing colIdx -> 目前正在累積延續格的 record(會被修改)
 * @param {Array<object>} params.records 輸出用陣列(會被 push)
 */
function processTimeSlotRow({ rows, r, startTime, colDateMap, master, ongoing, records }) {
  const masterDbName = master.masterDbName ?? master.name;

  for (const colIdxStr of Object.keys(colDateMap)) {
    const colIdx = Number(colIdxStr);
    const date = colDateMap[colIdx];
    const cellData = rows[r]?.[colIdx] ?? { value: null, colorHex: null };
    const rawText = cellData.value == null ? '' : String(cellData.value).trim();
    const { cleanedText: text, isCui } = extractCuiMarker(rawText);
    const colorTag = isCui ? 'cui' : resolveColorTag(cellData.colorHex);

    if (text === '') {
      if (colorTag === 'none') {
        delete ongoing[colIdx];
        continue;
      }
      // 空白但底色有意義(休假/自訂)：Hanna 看過畫面後不喜歡合併成一格
      // (跟同行者那次一樣的理由——合併會導致單一格在資料庫比對時對不到)，
      // 每一格都各自獨立一筆，不delete ongoing[colIdx]。
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
      };
      records.push(record);
      // 故意不設 ongoing[colIdx] = record——這種空白色塊格不會是延續符號的
      // 「錨點」，萬一後面接了一個延續符號，要讓它落到「找不到可以延續的
      // 東西」那個 needsReview 分支，而不是被誤接到休假/自訂區塊上。
      delete ongoing[colIdx];
      continue;
    }

    const isConfirmedContinuation = master.continuationMarks.includes(text);
    if (isConfirmedContinuation && ongoing[colIdx]) {
      // 不是「同一人療程比較長」——查證過 app 自己建立多位同行客人時，
      // 是同師傅連續時段「每人各佔一格」，各自一筆 bookings 資料列，
      // customerName 是「原名-同行」或「原名-同行1/2/3...」(超過2人才編號)。
      // 延續符號代表的正是這個模式，所以這裡要各自產生獨立的一筆記錄，
      // 不能合併成一筆(合併會導致這幾格在資料庫裡對應的既有預約，被
      // reconcile-month 誤判成「Sheet 上找不到對應」而錯誤標記取消——
      // 這是真的發生過的事故，不是假設)。
      // customerName 最後的編號要看這組同行者總共幾位，這裡先記下來，
      // 掃完整個 block 之後再統一回頭填(見下面迴圈外的 companions 後處理)。
      const anchor = ongoing[colIdx];
      const companionRecord = {
        masterName: masterDbName,
        sheetMasterLabel: master.name,
        date,
        startTime,
        customerName: null, // 先留空，掃完這個 anchor 的所有同行者後才知道要編號幾號
        colorTag: anchor.colorTag,
        isNewCustomer: false,
        slotCount: 1,
        needsReview: false,
        reviewReasons: [],
      };
      records.push(companionRecord);
      anchor.companions = anchor.companions ?? [];
      anchor.companions.push(companionRecord);
      continue; // ongoing[colIdx] 保持指向 anchor 本人，讓下一位同行者能接著算
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

/**
 * 同行者命名後處理：比照 app 自己建立多位同行客人的規則(guestsNum>2 才編號，
 * 從 1 開始)。要等整個 block 掃完才能知道每組同行者的總人數，所以是個
 * 獨立的後處理步驟，個別分頁跟合併分頁的 parser 都要呼叫。
 * @param {Array<object>} records
 */
function assignCompanionNames(records) {
  for (const record of records) {
    if (record.companions?.length) {
      const totalGuests = record.companions.length + 1; // 本人 + 同行人數
      record.companions.forEach((companion, idx) => {
        const i = idx + 1; // 對齊 app 的 for (let i = 1; i < guestsNum; i++)
        const suffix = totalGuests > 2 ? String(i) : '';
        companion.customerName = `${record.customerName}-同行${suffix}`;
      });
      delete record.companions; // 內部暫存用，不需要留在最終結果裡
    }
  }
}

/**
 * @param {Array<object>} records
 * @returns {Promise<void>} 直接修改每筆 record，加上 identityKey/contentHash
 */
async function assignIdentityAndHash(records) {
  for (const record of records) {
    record.identityKey = buildIdentityKey({ masterName: record.masterName, date: record.date, startTime: record.startTime });
    record.contentHash = await hashContent({
      customerName: record.customerName,
      colorTag: record.colorTag,
      slotCount: record.slotCount,
    });
  }
}

/**
 * 把「{N}月-合併」(泓文+哲瑋併排版)分頁解析成某一位師傅的 BookingRecord[]。
 * 跟 parseGridIntoRecords 不同的地方只有「怎麼找到表頭/日期/這位師傅的
 * 欄位」，實際每一格怎麼處理(延續符號、顏色、#REF! 等)完全共用
 * processTimeSlotRow，業務規則保證一致。
 *
 * 分頁結構(已用 /debug/dump-raw 實際查證過，不是猜的)：
 * - 第 0 列：週日～週六 7 個標籤(合併儲存格，只在每欄配對的第一欄有值)
 * - 每個週區塊：「師傅」列(第 0 欄="師傅")上面那一列是日期列(週日欄位如果
 *   跨到上個月會是空的，沒有日期值，這一整天要跳過)；「師傅」列本身在
 *   每對欄位裡各自寫著師傅名字(例如「泓文」「哲瑋」)，用來動態判斷這位
 *   master 對應到哪一欄，不假設固定順序；接著 30 列時段(8:00~22:30，
 *   跟個別分頁一樣)；再來「每日人數」小計列。
 * @param {Array<Array<{value: any, colorHex: string|null}>>} rows
 * @param {{name: string, continuationMarks: string[], anonymousReturningCustomerMarks?: string[]}} master 泓文或哲瑋
 * @returns {Promise<Array<object>>}
 */
async function parseMergedGridIntoRecords(rows, master) {
  const subHeaderRows = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r]?.[0]?.value === '師傅') subHeaderRows.push(r);
  }
  if (subHeaderRows.length === 0) {
    throw new Error('合併分頁裡找不到任何「師傅」子表頭列，分頁結構可能跟預期不符');
  }

  const records = [];

  for (const subHeaderRow of subHeaderRows) {
    const dateRow = rows[subHeaderRow - 1] ?? [];
    const subHeader = rows[subHeaderRow] ?? [];

    const colDateMap = {};
    for (let w = 0; w < 7; w++) {
      const pairColA = 1 + w * 2;
      const pairColB = 2 + w * 2;
      const serial = dateRow[pairColA]?.value; // 日期只寫在配對的第一欄，兩位師傅共用
      if (serial == null || serial === '') continue; // 這天跨到別的月份分頁，不屬於這裡要顯示的範圍

      // 動態讀「師傅」列自己寫的名字來對應這位 master 是配對裡的哪一欄，
      // 不假設固定順序——比較不會因為 Sheet 排列改變而悄悄讀錯欄位。
      let masterCol = null;
      if (subHeader[pairColA]?.value === master.name) masterCol = pairColA;
      else if (subHeader[pairColB]?.value === master.name) masterCol = pairColB;
      if (masterCol == null) {
        throw new Error(`合併分頁第 ${subHeaderRow} 列(師傅子表頭)的第 ${pairColA}/${pairColB} 欄裡找不到「${master.name}」，可能欄位順序跟預期不符`);
      }
      colDateMap[masterCol] = serialToDateString(serial);
    }

    const dataStartRow = subHeaderRow + 1;

    // 結構驗證：資料列跑完後應該接著「每日人數」小計列，抓錯行數的話這裡
    // 會馬上報錯，不會悄悄讀錯資料到別的區塊上。
    const afterDataRow = rows[dataStartRow + SLOTS_PER_BLOCK];
    if (!afterDataRow || afterDataRow[0]?.value !== '每日人數') {
      throw new Error(
        `合併分頁週區塊(師傅列在第 ${subHeaderRow} 列)結構跟預期不符：第 ${dataStartRow + SLOTS_PER_BLOCK} 列應該是「每日人數」小計列，實際是 ${JSON.stringify(afterDataRow?.[0]?.value)}`
      );
    }

    const ongoing = {};
    for (let slot = 0; slot < SLOTS_PER_BLOCK; slot++) {
      const r = dataStartRow + slot;
      const timeSerial = rows[r]?.[0]?.value;
      const startTime = serialToTimeString(timeSerial);
      processTimeSlotRow({ rows, r, startTime, colDateMap, master, ongoing, records });
    }
  }

  assignCompanionNames(records);
  await assignIdentityAndHash(records);

  return records;
}

/**
 * 把單一師傅、單一分頁的完整格子資料解析成 BookingRecord[]。
 * @param {Array<Array<{value: any, colorHex: string|null}>>} rows sheetsApi.fetchGridRows() 的 rows
 * @param {{name: string, continuationMarks: string[]}} master
 * @returns {Promise<Array<object>>}
 */
async function parseGridIntoRecords(rows, master) {
  const weekdayCols = buildWeekdayColumnMap(rows);
  const headerRows = findBlockHeaderRows(rows);
  const records = [];

  for (const headerRow of headerRows) {
    const dateRow = rows[headerRow] ?? [];
    const colDateMap = {};
    for (const colIdx of Object.values(weekdayCols)) {
      const serial = dateRow[colIdx]?.value;
      if (serial != null && serial !== '') colDateMap[colIdx] = serialToDateString(serial);
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
      processTimeSlotRow({ rows, r, startTime, colDateMap, master, ongoing, records });
    }
  }

  assignCompanionNames(records);
  await assignIdentityAndHash(records);

  return records;
}

/**
 * 抓某位師傅、某個月份的記錄——依 master.sourceMode 決定要讀個別分頁還是
 * 合併分頁。合併分頁是泓文/哲瑋共用同一份，mergedCache 讓同一輪呼叫裡
 * 這兩位不會各自重複抓一次同樣的合併分頁。
 * @param {object} env
 * @param {{name: string, continuationMarks: string[], anonymousReturningCustomerMarks?: string[], sourceMode?: string}} master
 * @param {number} month
 * @param {string} accessToken
 * @param {Map<number, Array>} mergedCache month -> 合併分頁的 rows(跨呼叫共用)
 * @param {object} deps
 * @returns {Promise<Array<object>>}
 */
async function fetchAndParseForMasterMonth(env, master, month, accessToken, mergedCache, deps) {
  const doFetchGridRows = deps.fetchGridRows ?? defaultFetchGridRows;

  if (master.sourceMode === 'merged') {
    if (!mergedCache.has(month)) {
      const sheetTitle = `${month}月-合併`;
      try {
        // 合併分頁比個別分頁寬(7天x2師傅=14欄+A欄=15欄)，範圍要跟著放寬，
        // 不然哲瑋(每對欄位的第二欄)的資料會被切掉抓不到。
        const gridResult = await doFetchGridRows(env, { sheetTitle, range: 'A1:O260', accessToken });
        mergedCache.set(month, gridResult.rows);
      } catch (err) {
        throw new Error(`讀取分頁「${sheetTitle}」失敗: ${err.message}`);
      }
    }
    return parseMergedGridIntoRecords(mergedCache.get(month), master);
  }

  const sheetTitle = `${month}月-${master.name}`;
  let gridResult;
  try {
    gridResult = await doFetchGridRows(env, { sheetTitle, range: 'A1:H260', accessToken });
  } catch (err) {
    throw new Error(`讀取分頁「${sheetTitle}」失敗: ${err.message}`);
  }
  return parseGridIntoRecords(gridResult.rows, master);
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
  const mergedCache = new Map(); // month -> 合併分頁 rows，避免泓文/哲瑋各自重複抓

  const allRecords = [];
  for (const master of SHEET_MASTERS) {
    for (const { month } of months) {
      const records = await fetchAndParseForMasterMonth(env, master, month, accessToken, mergedCache, deps);
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

  const accessToken = await doGetAccessToken(env);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const mergedCache = new Map();

  const allRecords = [];
  for (const master of SHEET_MASTERS) {
    const records = await fetchAndParseForMasterMonth(env, master, month, accessToken, mergedCache, deps);
    // 分頁裡的週區塊可能帶到鄰月的日期(跨月那週)，只留真的屬於這個月的
    allRecords.push(...records.filter((r) => r.date.startsWith(monthPrefix)));
  }
  return allRecords;
}

/**
 * 確保某個 (year, month) 的資料已經在 cache 裡，沒有就去抓一次存進去。
 * 用來讓同一輪同步(可能涵蓋十幾個 weekKey，範圍擴大成上/當/下三個月之後
 * 尤其明顯)裡，同一個月份分頁只會真的打一次 Sheets API，不會因為好幾個
 * weekKey 剛好落在同一個月就重複抓、浪費 API 額度(這個問題實際發生過)。
 * @param {object} env
 * @param {number} year
 * @param {number} month
 * @param {Map<string, Array<object>>} cache key 是 "year-month"
 * @param {object} [deps]
 * @returns {Promise<Array<object>>} 這個月份的完整記錄(這個 cache 裡的複本)
 */
async function ensureMonthCached(env, year, month, cache, deps = {}) {
  const doFetchAndParseMonth = deps.fetchAndParseMonth ?? fetchAndParseMonth;
  const key = `${year}-${month}`;
  if (!cache.has(key)) {
    cache.set(key, await doFetchAndParseMonth(env, year, month, deps));
  }
  return cache.get(key);
}

/**
 * 跟 fetchAndParseWeek 做一樣的事(抓某一週的記錄)，但透過呼叫端傳進來、
 * 跨多次呼叫共用的月份 cache，同一輪同步裡重疊到的月份分頁不會重複抓。
 * 跨月的週(monthsSpannedByWeek 回傳超過一筆)一樣正確處理——各自從對應的
 * 月份 cache 拿資料、合併起來再篩選成這週的 7 天，不會漏資料。
 * @param {object} env
 * @param {string} weekKey
 * @param {Map<string, Array<object>>} cache
 * @param {object} [deps]
 * @returns {Promise<Array<object>>}
 */
async function fetchAndParseWeekCached(env, weekKey, cache, deps = {}) {
  const months = monthsSpannedByWeek(weekKey);
  const allRecords = [];
  for (const { year, month } of months) {
    const monthRecords = await ensureMonthCached(env, year, month, cache, deps);
    allRecords.push(...monthRecords);
  }
  const targetDates = new Set(weekDateStrings(weekKey));
  return allRecords.filter((r) => targetDates.has(r.date));
}

export {
  parseGridIntoRecords,
  parseMergedGridIntoRecords,
  findBlockHeaderRows,
  buildWeekdayColumnMap,
  monthsSpannedByWeek,
  fetchAndParseWeek,
  fetchAndParseMonth,
  ensureMonthCached,
  fetchAndParseWeekCached,
  SHEET_MASTERS,
  COLOR_HEX_TO_TAG,
  NEUTRAL_COLOR_HEXES,
  resolveColorTag,
  WEEKDAY_LABELS,
  SLOTS_PER_BLOCK,
  BLOCK_ROW_SPAN,
};
