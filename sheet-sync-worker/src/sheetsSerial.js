// sheetsSerial.js
//
// Google Sheets API 回傳的日期/時間是「序列數字」(跟 Excel 系統同源)：
// 從 1899-12-30 當作第 0 天開始算的天數，小數部分代表一天中的時間比例。
// 例如 8:00 AM 存成 0.333333...(=8/24)，日期存成整數天數。
// 這支只做序列數字 ↔ 實際日期/時間字串的轉換，純函式、不碰網路，方便完整測試。

const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30); // 1899-12-30
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 序列數字 → "YYYY-MM-DD"(只取日期部分，用序列數字的整數部分)
 * @param {number} serial
 * @returns {string}
 */
function serialToDateString(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) {
    throw new TypeError(`serialToDateString 需要數字，收到: ${serial}`);
  }
  const days = Math.floor(serial);
  const ms = SHEETS_EPOCH_UTC_MS + days * MS_PER_DAY;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 序列數字 → "HH:MM"(用序列數字的小數部分，四捨五入到最近的分鐘)
 * @param {number} serial
 * @returns {string}
 */
function serialToTimeString(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) {
    throw new TypeError(`serialToTimeString 需要數字，收到: ${serial}`);
  }
  const fraction = serial - Math.floor(serial);
  const totalMinutes = Math.round(fraction * 24 * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * "YYYY-MM-DD" → 序列數字(整數)，saveSnapshot/比對以外的場合如果需要反向轉換時用。
 * @param {string} dateStr
 * @returns {number}
 */
function dateStringToSerial(dateStr) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`無法解析日期字串: ${dateStr}`);
  return Math.round((ms - SHEETS_EPOCH_UTC_MS) / MS_PER_DAY);
}

export { serialToDateString, serialToTimeString, dateStringToSerial };
