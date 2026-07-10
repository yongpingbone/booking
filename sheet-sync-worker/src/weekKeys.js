// weekKeys.js
//
// 算出「這次同步要涵蓋哪幾個 weekKey」。
//
// 重要：師傅跟客人感知的「這一週」是台灣時間，Cloudflare Worker 內部跑的是 UTC，
// 傍晚以後兩邊看到的「今天日期」可能差一天，所以這裡明確用 Asia/Taipei 時區
// 去算「今天」，不要直接用 new Date() 的 UTC 值。
//
// weekKey 定義：該週星期一的日期字串 "YYYY-MM-DD"(台灣時間)。
// 如果 extract_history.py 裡週區塊的實際命名邏輯不是「週一」起算(例如是週日起算)，
// 這支要跟著調，但呼叫端(index.js)不需要跟著改。

const TAIPEI_TZ = 'Asia/Taipei';

/**
 * 取得某個時間點對應的台灣時間 "YYYY-MM-DD"。
 * @param {Date} date
 * @returns {string}
 */
function taipeiDateString(date) {
  // en-CA 的 formatToParts 會給 YYYY-MM-DD 順序，用 formatToParts 而不是直接 format
  // 是為了避免 locale 字串格式在不同 runtime 之間不一致。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * "YYYY-MM-DD" 這天(台灣時間、當天 00:00)是星期幾，0=週日...6=週六。
 * @param {string} dateStr
 * @returns {number}
 */
function taipeiWeekday(dateStr) {
  // 用中午 12:00 UTC 當基準時間去問「這天在台灣是星期幾」，避開午夜附近的邊界問題。
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: TAIPEI_TZ, weekday: 'short' }).format(probe);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekdayName];
}

/**
 * 某天所在那週的星期一日期字串。
 * @param {string} dateStr "YYYY-MM-DD"
 * @returns {string}
 */
function mondayOf(dateStr) {
  const weekday = taipeiWeekday(dateStr); // 0=Sun..6=Sat
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday; // 週日要往前推6天，其他往前推到週一
  const probe = new Date(`${dateStr}T12:00:00Z`);
  probe.setUTCDate(probe.getUTCDate() + diffToMonday);
  return taipeiDateString(probe);
}

/**
 * @param {Date} referenceDate 預設用現在時間，測試時可以傳固定值
 * @param {{weeksBack?: number, weeksAhead?: number}} [options]
 * @returns {string[]} 由舊到新排序的 weekKey 陣列
 */
function weekKeysToSync(referenceDate = new Date(), { weeksBack = 0, weeksAhead = 4 } = {}) {
  const todayStr = taipeiDateString(referenceDate);
  const currentMonday = mondayOf(todayStr);

  const keys = [];
  for (let offset = -weeksBack; offset <= weeksAhead; offset++) {
    const probe = new Date(`${currentMonday}T12:00:00Z`);
    probe.setUTCDate(probe.getUTCDate() + offset * 7);
    keys.push(taipeiDateString(probe));
  }
  return keys;
}

export { weekKeysToSync, mondayOf, taipeiDateString };
