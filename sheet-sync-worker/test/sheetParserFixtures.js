// sheetParserFixtures.js —— 測試用的假資料產生器，模擬 sheetsApi.fetchGridRows 的輸出格式

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function cell(value, colorHex = null) {
  return { value, colorHex };
}

/**
 * 建一個完整的「分頁」rows 陣列：第 1 列是星期表頭，接著是任意數量的週區塊。
 * @param {Array<{dateSerials: (number|null)[], slots: Record<number, [number, string, string|null][]>}>} blocks
 *   dateSerials: 長度 7 的陣列，對應 週日..週六 這個區塊的日期序列數字(null=這欄這個區塊沒有日期)
 *   slots: { [rowOffset 0~29]: [ [colIndex 0~6, text, colorHex], ... ] } —— 0~29 對應時段 8:00~22:30
 * @param {number} startRow rows 陣列裡第一個區塊表頭要放在哪個 index(預設 1，緊接在星期表頭後面)
 */
function buildSheetRows(blocks, startRow = 1) {
  const rows = [];
  rows[0] = [cell(null), ...WEEKDAYS.map((w) => cell(w))];

  let headerIdx = startRow;
  for (const block of blocks) {
    rows[headerIdx] = [cell('時間'), ...block.dateSerials.map((s) => cell(s))];
    for (let slot = 0; slot < 30; slot++) {
      const timeSerial = 8 / 24 + slot * (0.5 / 24);
      const rowCells = new Array(8).fill(null).map(() => cell(null));
      rowCells[0] = cell(timeSerial);
      const slotEntries = block.slots[slot] || [];
      for (const [col, text, colorHex] of slotEntries) {
        rowCells[col + 1] = cell(text, colorHex);
      }
      rows[headerIdx + 1 + slot] = rowCells;
    }
    const totalRow = new Array(8).fill(null).map(() => cell(null));
    totalRow[0] = cell('人數');
    rows[headerIdx + 31] = totalRow;
    rows[headerIdx + 32] = new Array(8).fill(null).map(() => cell(null));
    rows[headerIdx + 33] = new Array(8).fill(null).map(() => cell(null));
    headerIdx += 34;
  }
  return rows;
}

/**
 * 建一個「合併分頁」(泓文+哲瑋併排版)的 rows 陣列。結構：
 * - 第 0 列：週日..週六，只在每對欄位的第一欄放值(col 1,3,5,7,9,11,13)
 * - 每個週區塊：日期列(值放法跟第 0 列一樣，只在配對第一欄) → 「師傅」
 *   子表頭列(每對欄位各自寫「泓文」「哲瑋」) → 30 列時段 → 「每日人數」列
 * @param {Array<{dateSerials: (number|null)[], slots: Record<number, Record<number, {泓文?: [string, string|null], 哲瑋?: [string, string|null]}>>}>} blocks
 *   dateSerials: 長度 7，對應 週日..週六 這個區塊的日期序列數字(null=這天不屬於這個月份要顯示的範圍)
 *   slots: { [rowOffset 0~29]: { [weekday 0~6]: { 泓文: [text, colorHex], 哲瑋: [text, colorHex] } } }
 * @param {number} startRow 第一個區塊的日期列要放在哪個 index(預設 1)
 * @param {number} blockSpan 區塊之間間隔幾列(預設 34，跟個別分頁一樣；因為 parser 是動態搜尋「師傅」列，
 *   這個值不需要精確對應真實 Sheet 的間隔，只要每個區塊內部結構正確就行)
 */
function buildMergedSheetRows(blocks, startRow = 1, blockSpan = 34) {
  const COL_COUNT = 15; // A欄(index0) + 7天 x 2欄
  const emptyRow = () => new Array(COL_COUNT).fill(null).map(() => cell(null));

  const rows = [];
  const headerRow = emptyRow();
  WEEKDAYS.forEach((w, i) => {
    headerRow[1 + i * 2] = cell(w);
  });
  rows[0] = headerRow;

  let dateRowIdx = startRow;
  for (const block of blocks) {
    const dateRow = emptyRow();
    block.dateSerials.forEach((s, i) => {
      if (s != null) dateRow[1 + i * 2] = cell(s);
    });
    rows[dateRowIdx] = dateRow;

    const subHeaderRowIdx = dateRowIdx + 1;
    const subHeaderRow = emptyRow();
    subHeaderRow[0] = cell('師傅');
    for (let w = 0; w < 7; w++) {
      subHeaderRow[1 + w * 2] = cell('泓文');
      subHeaderRow[2 + w * 2] = cell('哲瑋');
    }
    rows[subHeaderRowIdx] = subHeaderRow;

    for (let slot = 0; slot < 30; slot++) {
      const timeSerial = 8 / 24 + slot * (0.5 / 24);
      const rowCells = emptyRow();
      rowCells[0] = cell(timeSerial);
      const slotEntry = block.slots[slot] || {};
      for (let w = 0; w < 7; w++) {
        const dayData = slotEntry[w];
        if (!dayData) continue;
        if (dayData['泓文']) {
          const [text, colorHex] = dayData['泓文'];
          rowCells[1 + w * 2] = cell(text, colorHex);
        }
        if (dayData['哲瑋']) {
          const [text, colorHex] = dayData['哲瑋'];
          rowCells[2 + w * 2] = cell(text, colorHex);
        }
      }
      rows[subHeaderRowIdx + 1 + slot] = rowCells;
    }

    const dailyCountRow = emptyRow();
    dailyCountRow[0] = cell('每日人數');
    rows[subHeaderRowIdx + 31] = dailyCountRow;

    dateRowIdx += blockSpan;
  }
  return rows;
}

export { buildSheetRows, buildMergedSheetRows, cell, WEEKDAYS };
