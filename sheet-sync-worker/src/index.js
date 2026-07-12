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
//   8. Sheet 上原本有、這次消失(格子被清空)的記錄 → 對應的資料庫預約
//      標記取消(Hanna 明確要求：填了名字=已確認、名字被刪掉=取消)
//   9. 不管有沒有變化，這次讀到的完整狀態存成新快照
//   10. 整輪執行結果寫一份 log
//
// sheetParser / validate / sheetWriter 都已經是真的實作了。sheetParser 讀
// Sheet、sheetWriter 寫備註這兩段需要真的打 sheets.googleapis.com，我的
// sandbox 連不到，部署後第一次跑務必看 log。

import { getLatestSnapshot, saveSnapshot, appendLog, deleteAllLogs, deleteStaleSnapshots, acquireSyncLock, releaseSyncLock } from './snapshotStore.js';
import { diffSnapshots } from './diff.js';
import { fetchAndParseWeek, fetchAndParseWeekCached, SHEET_MASTERS, monthsSpannedByWeek } from './sheetParser.js';
import { validateBookingRecord } from './validate.js';
import { markCellStatus, resolveCellReference } from './sheetWriter.js';
import { saveBooking, findGarbageBookings, cancelBooking, setBookingStatus, upsertCustomerVisit, fetchActiveMasters, findBookingAtSlot, fetchSyncEnabledMasterNames } from './supabaseClient.js';
import { reconcileMonth } from './reconcile.js';
import { weekKeysToSync, mondayOf, taipeiDateString } from './weekKeys.js';
import { getAccessToken } from './googleAuth.js';
import { getCellNote, listSheetTabs, setCellNote, scanTabForNotes, clearMultipleCellNotes, fetchGridRows } from './sheetsApi.js';

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
    upsertCustomerVisit: doUpsertCustomerVisit = upsertCustomerVisit,
    fetchActiveMasters: doFetchActiveMasters = fetchActiveMasters,
    findBookingAtSlot: doFindBookingAtSlot = findBookingAtSlot,
    cancelBooking: doCancelBooking = cancelBooking,
    fetchSyncEnabledMasterNames: doFetchSyncEnabledMasterNames = fetchSyncEnabledMasterNames,
    bypassSyncPause = false, // App 上「立即匯入」按鈕用：使用者主動明確按下去要
    // 匯入，這種情況要真的執行，不該被暫停自動匯入的設定擋住(暫停只影響
    // 排程自動觸發，不影響使用者自己主動要求的一次性匯入)。
    onlyMasterName = null, // App 上「立即匯入」按鈕如果是針對單一師傅，這一輪
    // 只處理這位師傅，其他師傅的記錄凍結不動。
    forceNoteRecheck = false, // 一次性強制重新檢查所有 synced 記錄的備註狀態，
    // 用來處理 noteCleared 這個追蹤欄位上線之前就已經卡住的舊資料(這批舊
    // 快照裡根本沒有 noteCleared 這個欄位，正常的追蹤邏輯偵測不到)。
  } = deps;

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const log = { weekKey, runId, startedAt };

  try {
    const previous = await getLatestSnapshot(env.SHEET_SYNC_BUCKET, weekKey);

    // 決定這一輪「真的要處理」的師傅是誰，其他人的記錄要凍結成快照裡原本
    // 的樣子，不要用剛抓到的新鮮內容——原因：(1) 暫停自動匯入的師傅，如果
    // 不凍結，暫停當下會被「消失=取消」那條規則誤取消所有既有預約，暫停
    // 期間新冒出的資料也不該被當新記錄寫入；(2) App「立即匯入」按鈕如果
    // 指定只匯入某一位師傅(onlyMasterName)，其他師傅這一輪也不該被動到，
    // 即使他們原本是啟用中的。凍結的定義：不在「真的要處理」名單裡的師傅，
    // 只認上次快照裡「本來就有」的那些，其他(消失或新出現)一律不理。
    let current = currentRecords;
    try {
      let activeMasterNames;
      if (onlyMasterName) {
        activeMasterNames = new Set([onlyMasterName]);
      } else if (bypassSyncPause) {
        activeMasterNames = null; // null 代表全部師傅都算(不凍結任何人)
      } else {
        activeMasterNames = await doFetchSyncEnabledMasterNames(env);
      }
      if (activeMasterNames) {
        current = currentRecords.filter((r) => activeMasterNames.has(r.masterName));
        for (const r of previous?.records ?? []) {
          if (!activeMasterNames.has(r.masterName)) current.push(r);
        }
      }
    } catch (err) {
      // 查詢暫停狀態本身失敗，安全起見直接當作「沒有人暫停」處理(用
      // 完全沒凍結過的原始 currentRecords)，不要讓這個查詢失敗變成
      // 擋住整輪同步——寧可这一輪照常處理，之後暫停狀態的查詢恢復正常
      // 就會接手，不會有資料遺失的風險。
      current = currentRecords;
    }

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
        // 更新 customers 表的到訪統計——這裡失敗不影響預約本身已經同步成功，
        // 只是記錄一下，不中斷整輪同步(比照下面 markCellStatus 失敗的處理方式)。
        await doUpsertCustomerVisit(env, {
          phone: validation.row.customer_phone,
          name: validation.row.customer_name,
          visitDate: validation.row.date,
        });
      } catch (err) {
        log.results.push({ identityKey: record.identityKey, status: 'upsert_customer_visit_failed', error: String(err?.message ?? err) });
      }
      try {
        // 清掉這格可能留著的舊備註(例如上一輪驗證失敗留下的錯誤訊息)，
        // 不然問題明明已經解決了，Sheet 上還會一直顯示過期的錯誤提示。
        await doMarkCellStatus(env, record, { type: 'synced' });
      } catch (err) {
        // 清備註失敗不影響這筆資料本身已經成功寫進資料庫這件事，只是
        // Sheet 上可能還留著舊備註沒清掉——記下來，下面的 noteCleared 追蹤
        // 會確保下一輪單獨重試清備註這個動作(不用整筆重新驗證寫入一次)。
        log.results.push({ identityKey: record.identityKey, status: 'clear_cell_status_failed', error: String(err?.message ?? err) });
      }
    }

    // 資料本身是對的(synced)，但清備註那個步驟可能失敗過——這是跟資料驗證
    // 失敗完全獨立的另一種「卡住」，兩者互不相干(實測發生過：資料庫寫入
    // 成功、debug 端點也確認沒有 invalid 記錄，但 Sheet 上舊備註還在，就是
    // 卡在這裡)。找出這批、單獨重試清備註，不用整筆重新驗證寫入。
    const previousNoteFailedKeys = new Set(
      (previous?.records ?? []).filter((r) => r.lastStatus === 'synced' && r.noteCleared === false).map((r) => r.identityKey)
    );
    const toProcessKeys = new Set(toProcess.map((r) => r.identityKey));
    const noteRetryOnly = diffResult.unchanged.filter(
      (r) => !toProcessKeys.has(r.identityKey) && (forceNoteRecheck || previousNoteFailedKeys.has(r.identityKey))
    );
    log.diffSummary.noteRetried = noteRetryOnly.length;

    for (const record of noteRetryOnly) {
      try {
        await doMarkCellStatus(env, record, { type: 'synced' });
        log.results.push({ identityKey: record.identityKey, status: 'note_cleared_on_retry' });
      } catch (err) {
        log.results.push({ identityKey: record.identityKey, status: 'clear_cell_status_failed', error: String(err?.message ?? err) });
      }
    }

    // Sheet 上原本有預約、現在格子空了 → 對應的資料庫預約要標記取消。
    // Hanna 明確要求的規則：填了名字=已確認，名字被刪掉=取消，師傅在 Sheet
    // 上刪格子這個動作本身就是他們取消預約的方式，同步要正確反映這件事。
    // diffResult.removed 這個資訊本來就有算出來，只是一直沒有真的拿去用。
    for (const record of diffResult.removed) {
      try {
        const masters = await doFetchActiveMasters(env);
        const masterByName = Object.fromEntries(masters.map((m) => [m.name, m.id]));
        const masterId = masterByName[record.masterName];
        if (!masterId) {
          log.results.push({ identityKey: record.identityKey, status: 'cancel_skipped_master_not_found' });
          continue;
        }
        const existing = await doFindBookingAtSlot(env, { masterId, date: record.date, startTime: record.startTime });
        if (!existing) {
          // 資料庫裡本來就沒有有效預約(可能早就被取消過、或者這筆本來就
          // 沒成功寫進去過)，沒有東西可以取消，不算錯誤。
          log.results.push({ identityKey: record.identityKey, status: 'cancel_skipped_nothing_to_cancel' });
          continue;
        }
        await doCancelBooking(env, existing.id);
        log.results.push({ identityKey: record.identityKey, status: 'cancelled_removed_from_sheet' });
      } catch (err) {
        // 取消失敗目前沒有像 lastStatus/noteCleared 那樣的下一輪自動重試
        // 機制(這筆記錄已經不在 current 裡了，不會再進到下次的快照)，先
        // 確保至少會被清楚記錄下來，之後如果這個狀況常發生，需要另外設計
        // 追蹤方式。
        log.results.push({ identityKey: record.identityKey, status: 'cancel_failed', error: String(err?.message ?? err) });
      }
    }

    // 存快照前，把這次的處理結果(或者沒被重新處理時、沿用上次的結果)記到
    // 每筆記錄的 lastStatus/lastError/noteCleared 上，讓下一輪知道哪些記錄
    // 即使 unchanged 也要重試(驗證失敗的整筆重試、只有清備註失敗的單獨重試)，
    // 也讓 /debug/invalid-records 這類診斷端點能直接看到卡在哪裡。
    const resultsByKey = new Map();
    for (const result of log.results) {
      if (!result.identityKey) continue;
      if (!resultsByKey.has(result.identityKey)) resultsByKey.set(result.identityKey, []);
      resultsByKey.get(result.identityKey).push(result);
    }
    const statusByKey = new Map();
    for (const [key, results] of resultsByKey) {
      const invalidResult = results.find((r) => r.status === 'invalid' || r.status === 'validation_error');
      if (invalidResult) {
        const error = invalidResult.errors ? invalidResult.errors.join('; ') : invalidResult.error ?? null;
        statusByKey.set(key, { status: 'invalid', error, noteCleared: null });
        continue;
      }
      const hasSynced = results.some((r) => r.status === 'synced' || r.status === 'note_cleared_on_retry');
      if (hasSynced) {
        const hasClearFailed = results.some((r) => r.status === 'clear_cell_status_failed');
        statusByKey.set(key, { status: 'synced', error: null, noteCleared: !hasClearFailed });
      }
    }
    const previousStatusByKey = new Map(
      (previous?.records ?? []).map((r) => [r.identityKey, { status: r.lastStatus, error: r.lastError, noteCleared: r.noteCleared }])
    );
    const currentWithStatus = current.map((r) => {
      const resolved = statusByKey.get(r.identityKey) ?? previousStatusByKey.get(r.identityKey) ?? { status: 'synced', error: null, noteCleared: true };
      return {
        ...r,
        lastStatus: resolved.status ?? 'synced',
        lastError: resolved.error ?? null,
        noteCleared: resolved.noteCleared ?? true,
      };
    });

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
 * @param {boolean} [forceNoteRecheck]
 * @returns {Promise<object>}
 */
async function safelyFetchAndSyncWeek(env, weekKey, monthCache, options = {}) {
  const { forceNoteRecheck = false, bypassSyncPause = false, onlyMasterName = null } = options;
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
  return runSyncForWeekWithRecords(env, weekKey, currentRecords, { forceNoteRecheck, bypassSyncPause, onlyMasterName });
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
        // 保護機制：上一輪(不管是這個排程、還是手動/即時觸發的)如果還在
        // 跑，這一輪直接跳過，不要疊上去——不然兩輪同時讀寫同一份資料，
        // 會互相干擾判斷基準、甚至撞資料庫寫入衝突。
        const runId = crypto.randomUUID();
        const lock = await acquireSyncLock(env.SHEET_SYNC_BUCKET, runId);
        if (!lock.acquired) {
          console.log(`[sheet-sync] runId=${runId} 跳過這輪：上一輪(runId=${lock.existingLock?.runId}，${lock.existingLock?.acquiredAt} 開始)還在執行中`);
          return;
        }
        try {
          for (const weekKey of weekKeys) {
            await safelyFetchAndSyncWeek(env, weekKey, monthCache);
          }
        } finally {
          await releaseSyncLock(env.SHEET_SYNC_BUCKET);
        }
      })()
    );
  },

  /**
   * 手動觸發：
   *   POST /sync -- body 可選 { "weekKey": "2026-07-06" } 或
   *     { "scope": "current" }(目前三個月範圍全部重跑)或
   *     { "weekKeys": [...] }(指定多個 weekKey)，都不給就用當週。
   *   POST /reconcile-month -- 一次性月份校正，body { "year": 2026, "month": 7,
   *     "dryRun": true } —— dryRun 預設 true，只回報會取消哪些，不會真的動手；
   *     要看過 dry run 結果、確定沒問題後，才帶 "dryRun": false 真的執行。
   *   GET /debug/invalid-records -- 診斷用，列出目前三個月範圍內所有還卡在
   *     invalid 狀態的記錄跟上次失敗原因，不用再靠 Dashboard 畫面截圖確認。
   * 認證方式比照 notify-master-line 的 dual-auth 模式：這裡先用 shared secret，
   * 之後如果要開放師傅端 app 直接呼叫，可以再加 LINE idToken 驗證。
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/debug/invalid-records' && request.method === 'GET') {
      const providedSecret = request.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      // 診斷用：掃目前三個月範圍內每個 weekKey 的快照，把 lastStatus 還是
      // 'invalid' 的記錄整理出來(含上次失敗的原因)。不用再靠 Dashboard
      // 畫面截圖確認卡在哪裡，直接看 R2 存的實際狀態。
      const weekKeys = weekKeysToSync(new Date());
      const invalidRecords = [];
      for (const weekKey of weekKeys) {
        const snapshot = await getLatestSnapshot(env.SHEET_SYNC_BUCKET, weekKey).catch(() => null);
        for (const r of snapshot?.records ?? []) {
          if (r.lastStatus === 'invalid') {
            invalidRecords.push({
              weekKey,
              identityKey: r.identityKey,
              masterName: r.masterName,
              date: r.date,
              startTime: r.startTime,
              customerName: r.customerName,
              lastError: r.lastError,
            });
          }
        }
      }
      return Response.json({ scannedWeekKeys: weekKeys, invalidCount: invalidRecords.length, invalidRecords }, { status: 200 });
    }

    if (url.pathname === '/debug/dump-raw' && request.method === 'GET') {
      const providedSecret = request.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      // 診斷用：原始傾印某個範圍每一格的值(不聚合、不分類)，用來精確搞懂
      // 合併分頁這種比較複雜的欄位結構，不要用猜的。
      const sheetTitle = url.searchParams.get('sheetTitle');
      const range = url.searchParams.get('range') || 'A1:K10';
      if (!sheetTitle) {
        return Response.json({ error: '需要 sheetTitle' }, { status: 400 });
      }
      try {
        const accessToken = await getAccessToken(env);
        const { rows } = await fetchGridRows(env, { sheetTitle, range, accessToken });
        const dump = rows.map((row, rowIndex) => row.map((cell, colIndex) => ({ rowIndex, colIndex, value: cell.value, colorHex: cell.colorHex })));
        return Response.json({ sheetTitle, range, dump }, { status: 200 });
      } catch (err) {
        return Response.json({ error: String(err?.stack ?? err?.message ?? err) }, { status: 500 });
      }
    }

    if (url.pathname === '/debug/dump-grid' && request.method === 'GET') {
      const providedSecret = request.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      // 診斷用：原始傾印某個範圍的格子內容(value)，不做任何解析，純粹拿來
      // 搞懂一個分頁的實際結構(合併分頁的欄位對應目前完全不確定，需要先
      // 看過原始資料才能設計解析邏輯，不要用猜的)。
      const sheetTitle = url.searchParams.get('sheetTitle');
      const range = url.searchParams.get('range') || 'A1:P30';
      if (!sheetTitle) {
        return Response.json({ error: '需要 sheetTitle' }, { status: 400 });
      }
      try {
        const accessToken = await getAccessToken(env);
        const { rows } = await fetchGridRows(env, { sheetTitle, range, accessToken });
        const grid = rows.map((row) => row.map((cell) => cell.value));
        return Response.json({ sheetTitle, range, grid }, { status: 200 });
      } catch (err) {
        return Response.json({ error: String(err?.stack ?? err?.message ?? err) }, { status: 500 });
      }
    }

    if (url.pathname === '/debug/scan-colors' && request.method === 'GET') {
      const providedSecret = request.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      // 診斷用：直接掃某個分頁範圍內每一格「實際」的顏色分佈，拿來跟資料庫
      // 裡的 color_tag 統計對照，確認落差是出在「抓取/顏色判斷」這一段，
      // 還是後面某個步驟把資料弄掉了。
      const sheetTitle = url.searchParams.get('sheetTitle');
      const range = url.searchParams.get('range') || 'A1:H260';
      if (!sheetTitle) {
        return Response.json({ error: '需要 sheetTitle' }, { status: 400 });
      }
      try {
        const accessToken = await getAccessToken(env);
        const { rows } = await fetchGridRows(env, { sheetTitle, range, accessToken });
        const colorCounts = {};
        const yellowCells = [];
        const redCells = [];
        rows.forEach((row, rowIndex) => {
          row.forEach((cell, colIndex) => {
            const key = cell.colorHex ?? 'null(無底色)';
            colorCounts[key] = (colorCounts[key] ?? 0) + 1;
            if (cell.colorHex === '#FFFF00') {
              yellowCells.push({ rowIndex, colIndex, value: cell.value });
            }
            if (cell.colorHex === '#FF0000') {
              redCells.push({ rowIndex, colIndex, value: cell.value });
            }
          });
        });
        return Response.json(
          {
            sheetTitle,
            range,
            colorCounts,
            yellowCellCount: yellowCells.length,
            yellowCells: yellowCells.slice(0, 30),
            redCellCount: redCells.length,
            redCells: redCells.slice(0, 30),
          },
          { status: 200 }
        );
      } catch (err) {
        return Response.json({ error: String(err?.stack ?? err?.message ?? err) }, { status: 500 });
      }
    }

    if (url.pathname === '/debug/inspect-cell' && request.method === 'GET') {
      const providedSecret = request.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      // 診斷用：直接讀某一格在 Google 那邊實際存的備註內容，不靠猜的。
      // ?date=2026-07-09&startTime=14:00&sheetMasterLabel=麒&clear=true
      // clear=true 時，讀完現況後會再嘗試清空備註、然後馬上再讀一次確認
      // 有沒有真的清掉——整個過程完全透明，不隱藏任何一步的結果。
      const date = url.searchParams.get('date');
      const startTime = url.searchParams.get('startTime');
      const sheetMasterLabel = url.searchParams.get('sheetMasterLabel');
      const shouldClear = url.searchParams.get('clear') === 'true';
      if (!date || !startTime || !sheetMasterLabel) {
        return Response.json({ error: '需要 date、startTime、sheetMasterLabel 三個查詢參數' }, { status: 400 });
      }
      try {
        const cellRef = resolveCellReference({ date, startTime, sheetMasterLabel });
        const accessToken = await getAccessToken(env);
        const allTabs = await listSheetTabs(env, { accessToken });
        const matchingTabs = allTabs.filter((t) => t.title === cellRef.sheetTitle);

        const before = await getCellNote(env, { ...cellRef, accessToken });

        let afterClear = null;
        if (shouldClear) {
          await setCellNote(env, { ...cellRef, note: null, accessToken });
          afterClear = await getCellNote(env, { ...cellRef, accessToken });
        }

        return Response.json(
          {
            computedCellReference: cellRef,
            allTabsCount: allTabs.length,
            matchingTabsForThisTitle: matchingTabs, // 如果這個陣列長度 > 1，代表有重複分頁名稱，會抓錯 sheetId
            noteBeforeClear: before,
            clearAttempted: shouldClear,
            noteAfterClear: afterClear,
          },
          { status: 200 }
        );
      } catch (err) {
        return Response.json({ error: String(err?.stack ?? err?.message ?? err) }, { status: 500 });
      }
    }

    if (url.pathname === '/debug/sweep-notes' && request.method === 'POST') {
      const providedSecret = request.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      // 一次性全面清理：掃過目前三個月範圍內、每位師傅每個月份分頁的整個
      // 範圍，找出所有掛著非空備註的格子(不管有沒有對應到我系統目前追蹤
      // 中的記錄——這是跟平常同步機制完全獨立的路徑，用來清掉舊追蹤機制
      // 上線前就已經散落各處、追蹤機制根本不知道要去查的殘留)。
      // dryRun 預設 true，只回報找到什麼，不會真的清；bodyfalse 才會真的清除。
      const body = await request.json().catch(() => ({}));
      const dryRun = body.dryRun !== false;
      try {
        const accessToken = await getAccessToken(env);
        const weekKeys = weekKeysToSync(new Date());
        const monthSet = new Map(); // key "year-month" -> {year, month}
        for (const weekKey of weekKeys) {
          for (const m of monthsSpannedByWeek(weekKey)) monthSet.set(`${m.year}-${m.month}`, m);
        }

        const found = [];
        for (const { year, month } of monthSet.values()) {
          for (const master of SHEET_MASTERS) {
            const sheetTitle = `${month}月-${master.name}`;
            let notesInTab;
            try {
              notesInTab = await scanTabForNotes(env, { sheetTitle, range: 'A1:H260', accessToken });
            } catch (err) {
              found.push({ sheetTitle, error: String(err?.message ?? err) });
              continue;
            }
            for (const n of notesInTab) found.push({ sheetTitle, rowIndex: n.rowIndex, colIndex: n.colIndex, note: n.note });

            if (!dryRun && notesInTab.length > 0) {
              // 同一分頁裡不管找到幾格都包成一次 batchUpdate 呼叫——實測
              // 發現一格一格個別呼叫 setCellNote，兩三百格很快就撞到
              // Sheets API 的寫入頻率限制(HTTP 429)。包成一次呼叫不管
              // 幾格都算同一次 API 請求，不會有這個問題。
              try {
                await clearMultipleCellNotes(env, { sheetTitle, cells: notesInTab, accessToken });
                for (const n of notesInTab) {
                  const entry = found.find((f) => f.sheetTitle === sheetTitle && f.rowIndex === n.rowIndex && f.colIndex === n.colIndex);
                  if (entry) entry.cleared = true;
                }
              } catch (err) {
                const clearError = String(err?.message ?? err);
                for (const n of notesInTab) {
                  const entry = found.find((f) => f.sheetTitle === sheetTitle && f.rowIndex === n.rowIndex && f.colIndex === n.colIndex);
                  if (entry) {
                    entry.cleared = false;
                    entry.clearError = clearError;
                  }
                }
              }
            }
          }
        }
        return Response.json({ dryRun, scannedTabCount: monthSet.size * SHEET_MASTERS.length, foundCount: found.length, found }, { status: 200 });
      } catch (err) {
        return Response.json({ error: String(err?.stack ?? err?.message ?? err) }, { status: 500 });
      }
    }

    if (url.pathname === '/debug/clean-garbage-bookings' && request.method === 'POST') {
      const providedSecret = request.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      // 清理 needsReview 形同虛設那段期間，被誤當成真實姓名寫進資料庫的
      // 壞資料(customer_name 剛好是 #REF! 之類的公式錯誤殘留)。標記取消
      // (status=cancelled)，不是刪除，資料還在可以查回來。dryRun 預設
      // true，只回報找到什麼。
      const body = await request.json().catch(() => ({}));
      const dryRun = body.dryRun !== false;
      try {
        const garbageBookings = await findGarbageBookings(env);
        if (!dryRun) {
          for (const b of garbageBookings) await cancelBooking(env, b.id);
        }
        return Response.json({ dryRun, foundCount: garbageBookings.length, bookings: garbageBookings }, { status: 200 });
      } catch (err) {
        return Response.json({ error: String(err?.stack ?? err?.message ?? err) }, { status: 500 });
      }
    }

    if (url.pathname === '/debug/restore-bookings' && request.method === 'POST') {
      const providedSecret = request.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      // 復原用：body { "ids": [...], "status": "confirmed" }，把指定的預約
      // id 都設回指定的狀態。這支存在是因為 clean-garbage-bookings 執行
      // 後，Hanna 澄清那批 #REF! 資料其實是她自己 Google 綁定設定錯誤造成
      // 的，要保留自己排查，不是真的垃圾資料，需要復原剛剛的取消動作。
      const body = await request.json().catch(() => ({}));
      const { ids, status } = body;
      if (!Array.isArray(ids) || ids.length === 0 || !status) {
        return Response.json({ error: '需要 ids(非空陣列) 跟 status' }, { status: 400 });
      }
      try {
        const results = [];
        for (const id of ids) {
          try {
            await setBookingStatus(env, id, status);
            results.push({ id, ok: true });
          } catch (err) {
            results.push({ id, ok: false, error: String(err?.message ?? err) });
          }
        }
        return Response.json({ restoredCount: results.filter((r) => r.ok).length, failedCount: results.filter((r) => !r.ok).length, results }, { status: 200 });
      } catch (err) {
        return Response.json({ error: String(err?.stack ?? err?.message ?? err) }, { status: 500 });
      }
    }

    if (url.pathname === '/debug/cleanup-r2' && request.method === 'POST') {
      const providedSecret = request.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_SYNC_SECRET || providedSecret !== env.INTERNAL_SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      // 清理 R2：所有 logs/(純除錯用，同步邏輯不會讀)一律刪；
      // snapshots/ 只刪「已經不在目前三個月同步範圍內」的舊 weekKey，
      // 目前範圍內的完全不動(那是下次 diff 比對的基準，不能刪)。
      try {
        const currentWeekKeys = weekKeysToSync(new Date());
        const deletedLogCount = await deleteAllLogs(env.SHEET_SYNC_BUCKET);
        const { deletedCount: deletedSnapshotCount, keptWeekKeys } = await deleteStaleSnapshots(env.SHEET_SYNC_BUCKET, currentWeekKeys);
        return Response.json({ deletedLogCount, deletedSnapshotCount, keptWeekKeys }, { status: 200 });
      } catch (err) {
        return Response.json({ error: String(err?.stack ?? err?.message ?? err) }, { status: 500 });
      }
    }

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
      // forceNoteRecheck:true —— 一次性強制重新檢查所有已同步記錄的備註
      // 狀態，用來處理 noteCleared 追蹤機制上線前就已經卡住的舊資料。
      // bypassSyncPause:true —— App「立即匯入」按鈕用，就算師傅目前暫停
      // 自動匯入，這次還是要真的執行(暫停只影響排程自動觸發)。
      // masterName —— App「立即匯入」按鈕如果是針對單一師傅，只帶這位
      // 師傅的名字，這次只處理他，不動其他師傅。
      // background:true —— 立刻回傳「已開始」，實際同步在背景繼續跑(用
      // ctx.waitUntil)，不等全部跑完才回應。給呼叫端本身有執行時間限制
      // 的情境用(例如 Supabase Edge Function 直接等待可能會逾時)。
      const weekKeys = body.scope === 'current' ? weekKeysToSync(new Date()) : body.weekKeys;
      const syncOptions = {
        forceNoteRecheck: body.forceNoteRecheck === true,
        bypassSyncPause: body.bypassSyncPause === true,
        onlyMasterName: body.masterName ?? null,
      };
      // 保護機制只套用在「大範圍、可能跑很久」的批次觸發(沒有指定
      // onlyMasterName，代表要處理全部師傅)，不套用在單一師傅的立即匯入
      // (App 按鈕用，範圍窄、風險本來就低，不希望被排程中的大範圍同步
      // 卡住不能用)。
      const needsLock = !syncOptions.onlyMasterName;

      const runBatch = async () => {
        const monthCache = new Map();
        const logs = [];
        for (const weekKey of weekKeys) {
          logs.push(await safelyFetchAndSyncWeek(env, weekKey, monthCache, syncOptions));
        }
        return logs;
      };

      const runBatchWithLock = async () => {
        if (!needsLock) return runBatch();
        const runId = crypto.randomUUID();
        const lock = await acquireSyncLock(env.SHEET_SYNC_BUCKET, runId);
        if (!lock.acquired) {
          console.log(`[sheet-sync] runId=${runId} 跳過：上一輪(runId=${lock.existingLock?.runId}) 還在執行中`);
          return null; // null 代表被跳過，不是失敗
        }
        try {
          return await runBatch();
        } finally {
          await releaseSyncLock(env.SHEET_SYNC_BUCKET);
        }
      };

      if (body.background === true) {
        ctx.waitUntil(runBatchWithLock());
        return Response.json({ started: true, weekKeys }, { status: 202 });
      }

      const logs = await runBatchWithLock();
      if (logs === null) {
        return Response.json({ skipped: true, reason: '上一輪同步還在執行中，這次跳過' }, { status: 409 });
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
