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

export { getLatestSnapshot, saveSnapshot, appendLog, listLogs, latestKey, historyKey, logKey };
