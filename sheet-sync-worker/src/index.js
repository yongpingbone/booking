// index.js —— Worker entrypoint
//
// 整體流程(對照跟 Hanna 確認過的規劃)：
//   1. cron 或手動 /sync 觸發
//   2. 讀 R2 存的上次同步快照(snapshotStore)
//   3. 讀 Sheet、解析成 BookingRecord[](sheetParser —— 已完成)
//   4. diff 前後兩份快照(diff.js —— 已完成、已測試)
//   5. 對新增/異動的項目跑驗證，比照 CSV 匯入邏輯(validate —— 已完成)
//   6. 驗證過的寫進 bookings(supabaseClient —— 已完成，欄位對應待 schema 確認)
//   7. 驗證失敗/衝突的寫回 Sheet 提示師傅(sheetWriter —— 用儲存格備註，不改
//      內容/顏色，天生不影響 contentHash，不需要額外的防迴圈標記機制)
//   8. 不管有沒有變化，這次讀到的完整狀態存成新快照
//   9. 整輪執行結果寫一份 log
//
// sheetParser / validate / sheetWriter 都已經是真的實作了。sheetParser 讀
// Sheet、sheetWriter 寫備註這兩段需要真的打 sheets.googleapis.com，我的
// sandbox 連不到，部署後第一次跑務必看 log。

import { getLatestSnapshot, saveSnapshot, appendLog } from './snapshotStore.js';
import { diffSnapshots } from './diff.js';
import { fetchAndParseWeek } from './sheetParser.js';
import { validateBookingRecord } from './validate.js';
import { markCellStatus } from './sheetWriter.js';
import { upsertBooking } from './supabaseClient.js';
import { weekKeysToSync } from './weekKeys.js';

// bookings 表 upsert 時用哪個欄位組合判斷「這是同一筆」，等 schema 確認後調整。
const BOOKINGS_ON_CONFLICT_COLUMNS = 'master_id,start_time';

/**
 * @param {object} env
 * @param {string} weekKey
 * @param {object} [deps] 測試用依賴注入，production 呼叫端不需要傳這個參數，
 *   不傳就是用檔案最上面 import 進來的真正實作。
 * @returns {Promise<object>} 這一輪的 log 物件
 */
async function runSyncForWeek(env, weekKey, deps = {}) {
  const {
    fetchAndParseWeek: doFetchAndParseWeek = fetchAndParseWeek,
    validateBookingRecord: doValidateBookingRecord = validateBookingRecord,
    markCellStatus: doMarkCellStatus = markCellStatus,
    upsertBooking: doUpsertBooking = upsertBooking,
  } = deps;

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const log = { weekKey, runId, startedAt };

  try {
    const previous = await getLatestSnapshot(env.SHEET_SYNC_BUCKET, weekKey);
    const current = await doFetchAndParseWeek(env, weekKey);

    const diffResult = diffSnapshots(previous?.records ?? null, current);
    log.diffSummary = {
      added: diffResult.added.length,
      changed: diffResult.changed.length,
      removed: diffResult.removed.length,
      unchanged: diffResult.unchanged.length,
    };

    const toProcess = [...diffResult.added, ...diffResult.changed.map((c) => c.current)];
    const results = [];

    for (const record of toProcess) {
      let validation;
      try {
        validation = await doValidateBookingRecord(record, env);
      } catch (err) {
        results.push({ identityKey: record.identityKey, status: 'validation_error', error: String(err?.message ?? err) });
        continue;
      }

      if (!validation.valid) {
        results.push({ identityKey: record.identityKey, status: 'invalid', errors: validation.errors });
        await doMarkCellStatus(env, record, { type: 'invalid', message: validation.errors.join('; ') });
        continue;
      }

      await doUpsertBooking(env, validation.row, BOOKINGS_ON_CONFLICT_COLUMNS);
      results.push({ identityKey: record.identityKey, status: 'synced' });
    }

    log.results = results;
    await saveSnapshot(env.SHEET_SYNC_BUCKET, weekKey, current);

    log.ok = true;
  } catch (err) {
    log.ok = false;
    log.error = String(err?.stack ?? err?.message ?? err);
  }

  log.finishedAt = new Date().toISOString();

  if (!log.ok) {
    // 一定印到 Workers Logs，不依賴 R2 寫入成功——R2 本身寫入失敗時
    // (binding 設錯、bucket 沒接好等) 舊版邏輯會讓這裡完全看不到任何線索。
    console.error(`[sheet-sync] weekKey=${log.weekKey} runId=${log.runId} 失敗: ${log.error}`);
  } else {
    console.log(`[sheet-sync] weekKey=${log.weekKey} runId=${log.runId} 完成，diff=${JSON.stringify(log.diffSummary)}`);
  }

  await appendLog(env.SHEET_SYNC_BUCKET, log, log.finishedAt).catch((err) => {
    console.error(`[sheet-sync] log 寫進 R2 失敗(這不影響上面判斷同步本身成功與否): ${err?.message ?? err}`);
    // log 寫入失敗不該讓整個 request/cron 掛掉，這裡故意吞掉，
    // 但同步本身的成敗(log.ok)已經在上面決定好了，不受影響。
  });
  return log;
}

export default {
  /**
   * Cloudflare Cron Trigger 進來的排程同步。
   */
  async scheduled(event, env, ctx) {
    const weekKeys = weekKeysToSync(new Date(), {
      weeksBack: Number(env.SYNC_WEEKS_BACK ?? 0),
      weeksAhead: Number(env.SYNC_WEEKS_AHEAD ?? 4),
    });
    for (const weekKey of weekKeys) {
      ctx.waitUntil(runSyncForWeek(env, weekKey));
    }
  },

  /**
   * 手動觸發：POST /sync，body 可選 { "weekKey": "2026-07-06" }，不給就用當週。
   * 認證方式比照 notify-master-line 的 dual-auth 模式：這裡先用 shared secret，
   * 之後如果要開放師傅端 app 直接呼叫，可以再加 LINE idToken 驗證。
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/sync' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    const providedSecret = request.headers.get('X-Internal-Secret');
    if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const weekKey = body.weekKey ?? weekKeysToSync()[0];

    const log = await runSyncForWeek(env, weekKey);
    return Response.json(log, { status: log.ok ? 200 : 500 });
  },
};

export { runSyncForWeek, BOOKINGS_ON_CONFLICT_COLUMNS };
