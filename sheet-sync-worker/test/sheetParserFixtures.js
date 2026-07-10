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

export { buildSheetRows, cell, WEEKDAYS };
