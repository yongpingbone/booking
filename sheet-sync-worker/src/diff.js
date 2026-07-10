// diff.js
//
// 比對兩份「已解析」的預約快照（上次同步 vs 這次讀到的），
// 找出新增 / 異動 / 消失的項目。
//
// 這個 module 刻意不知道 Sheet 的儲存格長什麼樣子——它只操作
// BookingRecord 這個抽象格式，所以就算 extract_history.py 的解析
// 邏輯還沒接進來，這支的邏輯本身已經可以完整測試、確定是對的。
//
// BookingRecord 的最低需求欄位（sheetParser.js 完成後要保證產出這些）：
//   {
//     identityKey: string,   // 用來判斷「這是不是同一筆」的穩定 key
//     contentHash: string,   // 內容（含所有會顯示在 Sheet 上的欄位）的雜湊，用來判斷「內容有沒有變」
//     ...其他欄位 (masterName, date, startTime, ...) 原樣帶著，不比對，只是附加資訊
//   }
//
// identityKey 目前先用 masterName|date|startTime 這個自然鍵當預設假設，
// 等看到 extract_history.py 實際的欄位/格子定位邏輯後，如果有更穩定的
// 識別方式（例如格子本身有隱藏 ID），再換掉 buildIdentityKey 這一個函式即可，
// 不影響 diff 本身的邏輯。

/**
 * @typedef {Object} BookingRecord
 * @property {string} identityKey
 * @property {string} contentHash
 */

/**
 * @typedef {Object} DiffResult
 * @property {BookingRecord[]} added
 * @property {{previous: BookingRecord, current: BookingRecord}[]} changed
 * @property {BookingRecord[]} removed
 * @property {BookingRecord[]} unchanged
 */

/**
 * 比對前後兩份快照。
 * @param {BookingRecord[]|null} previousRecords 上次同步後存的快照；第一次同步、沒有舊快照時傳 null
 * @param {BookingRecord[]} currentRecords 這次從 Sheet 讀到、解析完的結果
 * @returns {DiffResult}
 */
function diffSnapshots(previousRecords, currentRecords) {
  if (!Array.isArray(currentRecords)) {
    throw new TypeError('currentRecords 必須是陣列（就算這次沒讀到任何預約，也要傳空陣列 []，不能傳 null/undefined）');
  }

  const previousMap = new Map();
  for (const record of previousRecords ?? []) {
    if (previousMap.has(record.identityKey)) {
      throw new Error(`previousRecords 裡有重複的 identityKey: ${record.identityKey}（每筆預約的 identityKey 應該唯一）`);
    }
    previousMap.set(record.identityKey, record);
  }

  const currentMap = new Map();
  for (const record of currentRecords) {
    if (currentMap.has(record.identityKey)) {
      throw new Error(`currentRecords 裡有重複的 identityKey: ${record.identityKey}（同一次讀取不應該解析出兩筆一樣 identityKey 的預約，可能是解析邏輯或 Sheet 本身有問題）`);
    }
    currentMap.set(record.identityKey, record);
  }

  const added = [];
  const changed = [];
  const unchanged = [];

  for (const [key, currentRecord] of currentMap) {
    const previousRecord = previousMap.get(key);
    if (!previousRecord) {
      added.push(currentRecord);
    } else if (previousRecord.contentHash !== currentRecord.contentHash) {
      changed.push({ previous: previousRecord, current: currentRecord });
    } else {
      unchanged.push(currentRecord);
    }
  }

  const removed = [];
  for (const [key, previousRecord] of previousMap) {
    if (!currentMap.has(key)) {
      removed.push(previousRecord);
    }
  }

  return { added, changed, removed, unchanged };
}

/**
 * 預設的 identityKey 產生方式（見檔案開頭說明，之後可能會換）。
 * @param {{masterName: string, date: string, startTime: string}} fields
 * @returns {string}
 */
function buildIdentityKey({ masterName, date, startTime }) {
  if (!masterName || !date || !startTime) {
    throw new Error('buildIdentityKey 需要 masterName / date / startTime 三個欄位都有值');
  }
  return `${masterName.trim()}|${date.trim()}|${startTime.trim()}`;
}

/**
 * 用 Web Crypto (SHA-256) 算內容雜湊，Workers runtime 原生支援、不需要 nodejs_compat。
 * @param {Record<string, unknown>} contentFields 會被拿來判斷「內容有沒有變」的欄位集合
 * @returns {Promise<string>}
 */
async function hashContent(contentFields) {
  const normalized = JSON.stringify(contentFields, Object.keys(contentFields).sort());
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export { diffSnapshots, buildIdentityKey, hashContent };
