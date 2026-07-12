// snapshotStore.js
//
// 用 R2 存「Sheet 快照歷史」跟「同步 log」。
//
// 重要：這裡用的是 Worker 的原生 R2 binding(env.SHEET_SYNC_BUCKET)，
// 不是 S3-compatible API，所以完全不需要 Access Key / Secret / R2 API Token
// ——這幾把在 wrangler.toml 綁定 bucket_name 之後，Cloudflare runtime 會自動
// 處理授權，程式碼裡永遠不會出現任何憑證。
//
// Key 規劃：
//   snapshots/{weekKey}/latest.json           最新一次同步後的快照，下次 diff 時的比對基準
//   snapshots/{weekKey}/history/{ts}.json      每次同步都額外存一份，供事後追查
//   logs/{yyyy-mm-dd}/{ts}_{runId}.json        每一輪同步的執行紀錄(讀到什麼、diff 出什麼、
//                                              驗證過了/沒過、寫進去了/衝突了)

const SNAPSHOT_FORMAT_VERSION = 1;
const SYNC_LOCK_KEY = 'sync-lock.json';
// 上一輪如果真的卡死(例如中途掛掉、沒有正常執行到 finally 釋放鎖)，鎖超過
// 這個時間就當作失效，允許下一輪接手，不會永遠卡住。30 分鐘遠超過正常一輪
// (就算是完整三個月範圍)實際會花的時間，足夠寬鬆、不會誤判正常執行中的
// 一輪為卡死。
const SYNC_LOCK_STALE_AFTER_MS = 30 * 60 * 1000;

function latestKey(weekKey) {
  assertSafeKeyPart(weekKey, 'weekKey');
  return `snapshots/${weekKey}/latest.json`;
}

function historyKey(weekKey, timestamp) {
  assertSafeKeyPart(weekKey, 'weekKey');
  return `snapshots/${weekKey}/history/${timestamp}.json`;
}

function logKey(timestamp, runId) {
  const datePart = timestamp.slice(0, 10); // "2026-07-10T12:34:56.789Z" -> "2026-07-10"
  return `logs/${datePart}/${timestamp}_${runId}.json`;
}

function assertSafeKeyPart(value, label) {
  if (!value || typeof value !== 'string' || /[\s/\\'"]/.test(value)) {
    throw new Error(`${label} 不合法："${value}"（不能是空值，也不能包含空白或 / \\ ' " 這些字元）`);
  }
}

/**
 * 讀取某個 week 上次同步後存的快照。第一次同步(還沒有任何快照)回傳 null。
 * @param {R2Bucket} bucket
 * @param {string} weekKey 例如 "2026-07-06"（週一日期），實際格式等 sheetParser 決定後再對齊
 * @returns {Promise<{records: object[], savedAt: string, formatVersion: number} | null>}
 */
async function getLatestSnapshot(bucket, weekKey) {
  const object = await bucket.get(latestKey(weekKey));
  if (!object) return null;
  const data = await object.json();
  if (data.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `snapshots/${weekKey}/latest.json 的 formatVersion 是 ${data.formatVersion}，跟目前程式預期的 ${SNAPSHOT_FORMAT_VERSION} 不一樣——` +
        `代表快照格式已經改過但沒寫遷移邏輯，不要盲目往下跑，先手動確認。`
    );
  }
  return data;
}

/**
 * 存這次同步後的最新狀態：更新 latest.json，同時額外存一份 history 存檔。
 * @param {R2Bucket} bucket
 * @param {string} weekKey
 * @param {object[]} records diff.js 用的 BookingRecord[]
 * @param {string} [timestamp] 預設用目前時間，測試時可以傳固定值
 */
async function saveSnapshot(bucket, weekKey, records, timestamp = new Date().toISOString()) {
  if (!Array.isArray(records)) {
    throw new TypeError('records 必須是陣列');
  }
  const payload = JSON.stringify({
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    weekKey,
    savedAt: timestamp,
    records,
  });
  // 兩個都要成功才算成功；history 先寫，這樣就算 latest 寫到一半失敗，
  // 至少 history 留得住這次讀到的內容，之後能手動救。
  await bucket.put(historyKey(weekKey, timestamp), payload);
  await bucket.put(latestKey(weekKey), payload);
}

/**
 * @param {R2Bucket} bucket
 * @param {object} logEntry 任意可序列化物件，建議至少包含 weekKey / runId / result 統計
 * @param {string} [timestamp]
 * @returns {Promise<{key: string}>}
 */
async function appendLog(bucket, logEntry, timestamp = new Date().toISOString()) {
  const runId = logEntry.runId ?? crypto.randomUUID();
  const key = logKey(timestamp, runId);
  await bucket.put(key, JSON.stringify({ timestamp, runId, ...logEntry }));
  return { key };
}

/**
 * 列出某一天(或全部)的 log key，由新到舊排。
 * @param {R2Bucket} bucket
 * @param {{date?: string, limit?: number}} [options] date 格式 "yyyy-mm-dd"，不給就列全部
 */
async function listLogs(bucket, { date, limit = 100 } = {}) {
  const prefix = date ? `logs/${date}/` : 'logs/';
  const result = await bucket.list({ prefix, limit });
  return result.objects.map((o) => o.key).sort().reverse();
}

/**
 * 刪掉所有 logs/ 底下的物件——這些純粹是除錯用的歷史紀錄，同步邏輯本身
 * 完全不會讀它，刪掉不影響任何功能。會處理分頁(R2 list 一次最多回傳
 * 有限筆數，物件多的話要用 cursor 繼續抓下一批)。
 * @param {R2Bucket} bucket
 * @returns {Promise<number>} 刪除的物件數量
 */
async function deleteAllLogs(bucket) {
  let deletedCount = 0;
  let cursor;
  do {
    const result = await bucket.list({ prefix: 'logs/', cursor });
    for (const obj of result.objects) {
      await bucket.delete(obj.key);
      deletedCount++;
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return deletedCount;
}

/**
 * 刪掉「已經不在目前同步範圍內」的舊 snapshots——包含 latest.json 跟底下
 * 全部的 history/*.json。目前範圍內的 weekKey 完全不會被動到(這是下次
 * diff 比對的基準，不能刪)。
 * @param {R2Bucket} bucket
 * @param {string[]} currentWeekKeys 目前還在同步範圍內的 weekKey 清單
 * @returns {Promise<{deletedCount: number, keptWeekKeys: string[]}>}
 */
async function deleteStaleSnapshots(bucket, currentWeekKeys) {
  const currentSet = new Set(currentWeekKeys);
  let deletedCount = 0;
  const keptWeekKeys = new Set();
  let cursor;
  do {
    const result = await bucket.list({ prefix: 'snapshots/', cursor });
    for (const obj of result.objects) {
      // key 格式: snapshots/{weekKey}/latest.json 或 snapshots/{weekKey}/history/{ts}.json
      const weekKey = obj.key.split('/')[1];
      if (currentSet.has(weekKey)) {
        keptWeekKeys.add(weekKey);
        continue;
      }
      await bucket.delete(obj.key);
      deletedCount++;
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return { deletedCount, keptWeekKeys: [...keptWeekKeys] };
}

export { getLatestSnapshot, saveSnapshot, appendLog, listLogs, latestKey, historyKey, logKey, deleteAllLogs, deleteStaleSnapshots };

/**
 * 嘗試取得同步鎖——用來避免上一輪同步還沒跑完，下一輪(排程或即時觸發)
 * 就疊上去，導致互相搶著讀寫同一份資料。
 * 用簡單的「先讀再寫」而不是真正的原子性 compare-and-swap，因為實務上
 * 真正會撞到的情境是「上一輪跑了好幾分鐘還沒完」，不是「兩個請求剛好
 * 差幾毫秒同時到」——前者才是真正要防的風險，用簡單做法就足夠涵蓋，
 * 不需要為了理論上極低機率的毫秒級競爭把邏輯搞複雜。
 * @param {R2Bucket} bucket
 * @param {string} runId 這一輪的識別碼，方便看鎖是誰持有的
 * @returns {Promise<{acquired: boolean, existingLock?: object}>}
 */
async function acquireSyncLock(bucket, runId) {
  const existing = await bucket.get(SYNC_LOCK_KEY);
  if (existing) {
    const data = await existing.json();
    const age = Date.now() - new Date(data.acquiredAt).getTime();
    if (age < SYNC_LOCK_STALE_AFTER_MS) {
      return { acquired: false, existingLock: data };
    }
    // 鎖太舊了，當作上一輪卡死(中途掛掉、沒有正常釋放)，允許這一輪接手。
  }
  const lockData = { acquiredAt: new Date().toISOString(), runId };
  await bucket.put(SYNC_LOCK_KEY, JSON.stringify(lockData));
  return { acquired: true };
}

/**
 * 釋放同步鎖。呼叫端要用 try/finally 包住，確保就算同步過程中丟出例外，
 * 鎖還是會被正常釋放，不會卡住下一輪。
 * @param {R2Bucket} bucket
 */
async function releaseSyncLock(bucket) {
  await bucket.delete(SYNC_LOCK_KEY);
}

export { acquireSyncLock, releaseSyncLock };
