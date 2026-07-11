// index.js —— Worker entrypoint
//
// 整體流程(對照跟 Hanna 確認過的規劃)：
//   1. cron 或手動 /sync 觸發
//   2. 讀 R2 存的上次同步快照(snapshotStore)
//   3. 讀 Sheet、解析成 BookingRecord[](sheetParser —— 已完成)
//   4. diff 前後兩份快照(diff.js —— 已完成、已測試)
//   5. 對新增/異動的項目跑驗證，比照 CSV 匯入邏輯(validate —— 已完成)
//   6. 驗證過的寫進 bookings(supabaseClient —— 已完成，欄位對應待 schema 確認)
//   7. 驗證失敗的寫回 Sheet 提示師傅(sheetWriter —— 用儲存格備註，不改
//      內容/顏色，天生不影響 contentHash，不需要額外的防迴圈標記機制)
//   8. 不管有沒有變化，這次讀到的完整狀態存成新快照
//   9. 整輪執行結果寫一份 log
//
// sheetParser / validate / sheetWriter 都已經是真的實作了。sheetParser 讀
// Sheet、sheetWriter 寫備註這兩段需要真的打 sheets.googleapis.com，我的
// sandbox 連不到，部署後第一次跑務必看 log。

import { getLatestSnapshot, saveSnapshot, appendLog } from './snapshotStore.js';
import { diffSnapshots } from './diff.js';
import { fetchAndParseWeek, fetchAndParseWeekCached } from './sheetParser.js';
import { validateBookingRecord } from './validate.js';
import { markCellStatus } from './sheetWriter.js';
import { saveBooking } from './supabaseClient.js';
import { reconcileMonth } from './reconcile.js';
import { weekKeysToSync, mondayOf, taipeiDateString } from './weekKeys.js';

/**
 * 實際的診斷/寫入邏輯，接受已經抓好的記錄陣列，不自己去打 Sheets API。
 * runSyncForWeek()(手動觸發用)跟 scheduled()(排程、多週共用月份 cache用)
 * 都是透過這支處理，差別只在「記錄怎麼來的」。
 * @param {object} env
 * @param {string} weekKey
 * @param {Array<object>} currentRecords 這週已經抓好、解析好的記錄
 * @param {object} [deps] 測試用依賴注入
 * @returns {Promise<object>} 這一輪的 log 物件
 */
async function runSyncForWeekWithRecords(env, weekKey, currentRecords, deps = {}) {
  const {
    validateBookingRecord: doValidateBookingRecord = validateBookingRecord,
    markCellStatus: doMarkCellStatus = markCellStatus,
    saveBooking: doSaveBooking = saveBooking,
  } = deps;

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const log = { weekKey, runId, startedAt };

  try {
    const previous = await getLatestSnapshot(env.SHEET_SYNC_BUCKET, weekKey);
    const current = currentRecords;

    const diffResult = diffSnapshots(previous?.records ?? null, current);
    log.diffSummary = {
      added: diffResult.added.length,
      changed: diffResult.changed.length,
      removed: diffResult.removed.length,
      unchanged: diffResult.unchanged.length,
    };

    // diffSnapshots 只比對 contentHash(Sheet 上會顯示的內容)，不知道「我的
    // 驗證/對照邏輯本身有沒有改過」。實測發現過：許老師/麒 那個師傅名字對照
    // 的 bug 修好後，Sheet 上的格子內容根本沒變(還是同一個字)，這些記錄在
    // diff 裡永遠是 unchanged，永遠不會被重新處理——代表就算程式邏輯的 bug
    // 修好了，先前失敗、留在 Sheet 上的錯誤備註也永遠不會被清掉、資料庫也
    // 永遠補不進去。這裡額外把「上次是 invalid、這次雖然 unchanged 但還是
    // 要重試」的記錄找出來，跟 added/changed 一起處理。
    const previouslyInvalidKeys = new Set(
      (previous?.records ?? []).filter((r) => r.lastStatus === 'invalid').map((r) => r.identityKey)
    );
    const retryUnchangedInvalid = diffResult.unchanged.filter((r) => previouslyInvalidKeys.has(r.identityKey));

    const toProcess = [...diffResult.added, ...diffResult.changed.map((c) => c.current), ...retryUnchangedInvalid];
    log.diffSummary.retriedInvalid = retryUnchangedInvalid.length;
    log.results = []; // 直接掛在 log 上、逐筆 push，不要等迴圈整個跑完才賦值——
    // 這樣就算中途某一筆意外丟出未預期的例外，前面已經處理過的筆數還是看得到，
    // 不會因為最後一筆爆炸就把整輪的進度都吞掉(這裡有真的發生過，setCellNote
    // 撞到 Sheets API 頻率限制，導致整輪的 results 直接消失，事後完全看不出
    // 卡在第幾筆)。

    for (const record of toProcess) {
      let validation;
      try {
        validation = await doValidateBookingRecord(record, env);
      } catch (err) {
        log.results.push({ identityKey: record.identityKey, status: 'validation_error', error: String(err?.message ?? err) });
        continue;
      }

      if (!validation.valid) {
        log.results.push({ identityKey: record.identityKey, status: 'invalid', errors: validation.errors });
        try {
          await doMarkCellStatus(env, record, { type: 'invalid', message: validation.errors.join('; ') });
        } catch (err) {
          // 寫備註失敗(例如 Sheets API 額度用完)不該讓整輪同步中斷——這筆的
          // 驗證結果已經正確記到 log.results 了，只是師傅暫時看不到 Sheet 上
          // 的提示，不影響其他筆繼續處理。
          log.results.push({ identityKey: record.identityKey, status: 'mark_cell_status_failed', error: String(err?.message ?? err) });
        }
        continue;
      }

      await doSaveBooking(env, validation.row, validation.existingId);
      log.results.push({ identityKey: record.identityKey, status: 'synced' });
      try {
        // 清掉這格可能留著的舊備註(例如上一輪驗證失敗留下的錯誤訊息)，
        // 不然問題明明已經解決了，Sheet 上還會一直顯示過期的錯誤提示。
        await doMarkCellStatus(env, record, { type: 'synced' });
      } catch (err) {
        // 清備註失敗不影響這筆資料本身已經成功寫進資料庫這件事，只是
        // Sheet 上可能還留著舊備註沒清掉，下一輪還會再試一次。
        log.results.push({ identityKey: record.identityKey, status: 'clear_cell_status_failed', error: String(err?.message ?? err) });
      }
    }

    // 存快照前，把這次的處理結果(或者沒被重新處理時、沿用上次的結果)記到
    // 每筆記錄的 lastStatus 上，讓下一輪知道哪些記錄即使 unchanged 也要重試。
    const statusByKey = new Map();
    for (const result of log.results) {
      if (!result.identityKey || statusByKey.has(result.identityKey)) continue;
      statusByKey.set(result.identityKey, result.status === 'synced' ? 'synced' : 'invalid');
    }
    const previousStatusByKey = new Map((previous?.records ?? []).map((r) => [r.identityKey, r.lastStatus]));
    const currentWithStatus = current.map((r) => ({
      ...r,
      lastStatus: statusByKey.get(r.identityKey) ?? previousStatusByKey.get(r.identityKey) ?? 'synced',
    }));

    await saveSnapshot(env.SHEET_SYNC_BUCKET, weekKey, currentWithStatus);

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

/**
 * @param {object} env
 * @param {string} weekKey
 * @param {object} [deps] 測試用依賴注入，production 呼叫端不需要傳這個參數，
 *   不傳就是用檔案最上面 import 進來的真正實作。
 * @returns {Promise<object>} 這一輪的 log 物件
 */
async function runSyncForWeek(env, weekKey, deps = {}) {
  const { fetchAndParseWeek: doFetchAndParseWeek = fetchAndParseWeek } = deps;

  let current;
  try {
    current = await doFetchAndParseWeek(env, weekKey);
  } catch (err) {
    // 抓取本身失敗(例如缺 Google 憑證、Sheets API 掛掉)要跟
    // runSyncForWeekWithRecords 內部失敗一樣優雅處理成 log.ok=false，
    // 不能讓例外直接往外丟——這支被 scheduled()/手動 /sync 呼叫，
    // 丟出未捕捉的例外會讓整個 cron 或 request 掛掉。
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const log = {
      weekKey,
      runId,
      startedAt,
      ok: false,
      error: String(err?.stack ?? err?.message ?? err),
      finishedAt: new Date().toISOString(),
    };
    console.error(`[sheet-sync] weekKey=${weekKey} runId=${runId} 抓取失敗: ${log.error}`);
    await appendLog(env.SHEET_SYNC_BUCKET, log, log.finishedAt).catch((appendErr) => {
      console.error(`[sheet-sync] log 寫進 R2 失敗: ${appendErr?.message ?? appendErr}`);
    });
    return log;
  }

  return runSyncForWeekWithRecords(env, weekKey, current, deps);
}

/**
 * scheduled() 跟手動批次 /sync(weekKeys 陣列)共用：安全地抓某一週的資料
 * 並處理，抓取本身失敗時回傳 log.ok=false 的結果，不會讓例外往外丟炸掉
 * 整個迴圈——不然一週抓失敗(例如剛好撞到 API 額度)會連帶讓迴圈裡排在
 * 後面、原本可以成功的週也一起沒跑到。
 * @param {object} env
 * @param {string} weekKey
 * @param {Map<string, Array<object>>} monthCache
 * @returns {Promise<object>}
 */
async function safelyFetchAndSyncWeek(env, weekKey, monthCache) {
  let currentRecords;
  try {
    currentRecords = await fetchAndParseWeekCached(env, weekKey, monthCache);
  } catch (err) {
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const log = {
      weekKey,
      runId,
      startedAt,
      ok: false,
      error: String(err?.stack ?? err?.message ?? err),
      finishedAt: new Date().toISOString(),
    };
    console.error(`[sheet-sync] weekKey=${weekKey} runId=${runId} 抓取失敗: ${log.error}`);
    await appendLog(env.SHEET_SYNC_BUCKET, log, log.finishedAt).catch((appendErr) => {
      console.error(`[sheet-sync] log 寫進 R2 失敗: ${appendErr?.message ?? appendErr}`);
    });
    return log;
  }
  return runSyncForWeekWithRecords(env, weekKey, currentRecords);
}

export default {
  /**
   * Cloudflare Cron Trigger 進來的排程同步。範圍固定是上個月/當月/下個月
   * (weekKeysToSync 自己算，Hanna 明確要求的標準範圍)。
   *
   * 範圍擴大成三個月(13~18 個 weekKey)之後，如果還是像以前一樣每個
   * weekKey 各自獨立呼叫 fetchAndParseWeek，會導致同一個月份分頁被重複
   * 抓好幾次(一個月通常有 4~5 個 weekKey 落在裡面)，很容易撞到 Sheets
   * API 的頻率限制(這個問題今天已經真的發生過一次)。改成：整輪排程共用
   * 一個月份 cache(monthCache)，用 fetchAndParseWeekCached 抓，同一個
   * 月份分頁整輪只會真的打一次 API；各 weekKey 依序處理(不是像以前用
   * ctx.waitUntil 各自平行跑)，一方面 cache 是共用的可變狀態、平行跑會有
   * 競爭問題，一方面依序執行本身也能讓 API 呼叫更平緩分散，不會瞬間爆量。
   */
  async scheduled(event, env, ctx) {
    const weekKeys = weekKeysToSync(new Date());
    const monthCache = new Map();
    ctx.waitUntil(
      (async () => {
        for (const weekKey of weekKeys) {
          await safelyFetchAndSyncWeek(env, weekKey, monthCache);
        }
      })()
    );
  },

  /**
   * 手動觸發：
   *   POST /sync -- body 可選 { "weekKey": "2026-07-06" }，不給就用當週。
   *   POST /reconcile-month -- 一次性月份校正，body { "year": 2026, "month": 7,
   *     "dryRun": true } —— dryRun 預設 true，只回報會取消哪些，不會真的動手；
   *     要看過 dry run 結果、確定沒問題後，才帶 "dryRun": false 真的執行。
   * 認證方式比照 notify-master-line 的 dual-auth 模式：這裡先用 shared secret，
   * 之後如果要開放師傅端 app 直接呼叫，可以再加 LINE idToken 驗證。
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || (url.pathname !== '/sync' && url.pathname !== '/reconcile-month')) {
      return new Response('Not found', { status: 404 });
    }

    const providedSecret = request.headers.get('X-Internal-Secret');
    if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    const body = await request.json().catch(() => ({}));

    if (url.pathname === '/reconcile-month') {
      if (!body.year || !body.month) {
        return Response.json({ error: '需要 year 跟 month(1-12)' }, { status: 400 });
      }
      const dryRun = body.dryRun !== false; // 沒明確傳 false 就當 true，安全優先
      try {
        const result = await reconcileMonth(env, { year: body.year, month: body.month, dryRun });
        return Response.json(result, { status: 200 });
      } catch (err) {
        return Response.json({ error: String(err?.message ?? err) }, { status: 500 });
      }
    }

    if (body.scope === 'current' || (body.weekKeys && Array.isArray(body.weekKeys))) {
      // scope:"current" —— 不用呼叫端自己列出 weekKeys，直接用跟 scheduled()
      // 一樣的邏輯(weekKeysToSync())算出目前的上/當/下三個月範圍。用來立即
      // 補跑目前完整範圍的資料，之後排程會自動接手，不用再手動觸發。
      // weekKeys 陣列 —— 呼叫端自己指定要跑哪幾個 weekKey(補跑特定範圍用)。
      const weekKeys = body.scope === 'current' ? weekKeysToSync(new Date()) : body.weekKeys;
      const monthCache = new Map();
      const logs = [];
      for (const weekKey of weekKeys) {
        logs.push(await safelyFetchAndSyncWeek(env, weekKey, monthCache));
      }
      const allOk = logs.every((l) => l.ok);
      return Response.json({ weekKeys, logs }, { status: allOk ? 200 : 500 });
    }

    // 手動觸發沒指定 weekKey 時，預設抓「這一週」——不能直接用
    // weekKeysToSync()[0]，那支現在回傳的是三個月範圍、由舊到新排序，
    // [0] 會變成上個月第一週，不是「當週」了。
    const weekKey = body.weekKey ?? mondayOf(taipeiDateString(new Date()));
    const log = await runSyncForWeek(env, weekKey);
    return Response.json(log, { status: log.ok ? 200 : 500 });
  },
};

export { runSyncForWeek, runSyncForWeekWithRecords };
