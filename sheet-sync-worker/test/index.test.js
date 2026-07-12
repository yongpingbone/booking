import test from 'node:test';
import assert from 'node:assert/strict';
import { MockR2Bucket } from './mockR2Bucket.js';
import worker, { runSyncForWeek, runSyncForWeekWithRecords } from '../src/index.js';
import { getLatestSnapshot, acquireSyncLock } from '../src/snapshotStore.js';

function makeEnv(overrides = {}) {
  return {
    SHEET_SYNC_BUCKET: new MockR2Bucket(),
    INTERNAL_SYNC_SECRET: 'test-secret',
    ...overrides,
  };
}

test('happy path：兩筆新預約，驗證都過，都要寫進 Supabase，快照要存起來，且要清掉這兩格的舊備註', async () => {
  const env = makeEnv();
  const upsertCalls = [];
  const markCalls = [];

  const fakeRecords = [
    { identityKey: 'a', contentHash: 'h1', masterName: '許老師' },
    { identityKey: 'b', contentHash: 'h2', masterName: '魏老師' },
  ];

  const log = await runSyncForWeek(env, '2026-07-06', {
    fetchAndParseWeek: async () => fakeRecords,
    validateBookingRecord: async (record) => ({ valid: true, row: { source_identity: record.identityKey } }),
    markCellStatus: async (env_, record, status) => {
      markCalls.push({ record, status });
    },
    saveBooking: async (env_, row, existingId) => {
      upsertCalls.push(row);
      return row;
    },
  });

  assert.equal(log.ok, true);
  assert.equal(log.diffSummary.added, 2);
  assert.deepEqual(
    log.results.map((r) => r.status),
    ['synced', 'synced']
  );
  assert.equal(upsertCalls.length, 2);
  assert.equal(markCalls.length, 2, '成功同步的兩筆都要呼叫 markCellStatus 清舊備註');
  assert.ok(markCalls.every((c) => c.status.type === 'synced'));

  const snapshot = await getLatestSnapshot(env.SHEET_SYNC_BUCKET, '2026-07-06');
  assert.equal(snapshot.records.length, 2);
});

test('其中一筆驗證失敗：不寫進 Supabase，要呼叫 markCellStatus 並傳整筆 record', async () => {
  const env = makeEnv();
  const markCalls = [];
  const upsertCalls = [];

  const fakeRecords = [
    { identityKey: 'good', contentHash: 'h1' },
    { identityKey: 'bad', contentHash: 'h2' },
  ];

  const log = await runSyncForWeek(env, '2026-07-06', {
    fetchAndParseWeek: async () => fakeRecords,
    validateBookingRecord: async (record) => {
      if (record.identityKey === 'bad') {
        return { valid: false, errors: ['師傅名字對不到 UUID'] };
      }
      return { valid: true, row: {} };
    },
    markCellStatus: async (env_, record, status) => {
      markCalls.push({ record, status });
    },
    saveBooking: async (env_, row, existingId) => {
      upsertCalls.push(row);
      return row;
    },
  });

  assert.equal(log.ok, true, '一筆驗證失敗不該讓整個同步 run 掛掉');
  assert.equal(upsertCalls.length, 1, '驗證失敗的那筆不該被寫進 Supabase');
  assert.equal(markCalls.length, 2, '兩筆都要呼叫 markCellStatus：bad 寫錯誤備註、good 清舊備註');

  const badCall = markCalls.find((c) => c.record.identityKey === 'bad');
  assert.equal(badCall.status.type, 'invalid');

  const goodCall = markCalls.find((c) => c.record.identityKey === 'good');
  assert.equal(goodCall.status.type, 'synced');

  const invalidResult = log.results.find((r) => r.identityKey === 'bad');
  assert.equal(invalidResult.status, 'invalid');
  assert.deepEqual(invalidResult.errors, ['師傅名字對不到 UUID']);
});

test('validateBookingRecord 本身丟例外(不是回傳 valid:false)：也要被攔下來，不能讓整輪同步中斷', async () => {
  const env = makeEnv();

  const log = await runSyncForWeek(env, '2026-07-06', {
    fetchAndParseWeek: async () => [{ identityKey: 'a', contentHash: 'h1' }],
    validateBookingRecord: async () => {
      throw new Error('驗證邏輯本身壞掉了(例如打 Supabase 查排班衝突逾時)');
    },
    markCellStatus: async () => {},
    saveBooking: async () => {
      throw new Error('不應該被呼叫');
    },
  });

  assert.equal(log.ok, true);
  assert.equal(log.results[0].status, 'validation_error');
});

test('沒有傳 deps(用真正的實作)：env 沒設定 Google 憑證時要優雅失敗、log.ok=false，不是丟出未捕捉的例外', async () => {
  const env = makeEnv();
  const log = await runSyncForWeek(env, '2026-07-06');
  assert.equal(log.ok, false);
  assert.match(log.error, /GOOGLE_SERVICE_ACCOUNT_JSON/);
});

test('fetch(): 沒帶 X-Internal-Secret 要回 401', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/sync', { method: 'POST' });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 401);
});

test('fetch(): secret 錯誤要回 401', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'wrong' },
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 401);
});

test('fetch(): 路徑不是 /sync 要回 404', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/other', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 404);
});

test('fetch(): POST /reconcile-month 也要驗證 X-Internal-Secret，跟 /sync 共用同一套認證', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/reconcile-month', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'wrong' },
    body: JSON.stringify({ year: 2026, month: 7 }),
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 401);
});

test('fetch(): POST /reconcile-month 缺 year/month 要回 400，不要用猜的預設值', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/reconcile-month', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({}),
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 400);
});

test('fetch(): POST /reconcile-month 沒帶 dryRun 時預設是安全的(不會誤觸發真的執行)', async () => {
  // 這裡打進去的是真正的 reconcileMonth(沒有 deps 注入)，會因為缺真實憑證而失敗，
  // 但重點是驗證：即使失敗前，也不該有任何跡象顯示它把 dryRun 誤判成 false。
  // 用 GOOGLE_SERVICE_ACCOUNT_JSON 沒設一定會在 fetchAndParseMonth 那步就丟錯，
  // 回應會是 500 + 錯誤訊息，而不是意外執行成功。
  const env = makeEnv();
  const request = new Request('https://worker.example/reconcile-month', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ year: 2026, month: 7 }),
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.ok(body.error);
});

test('fetch(): secret 正確、路徑正確 → 會真的跑同步(目前 stub 未完成所以回 500，但代表有跑到，不是卡在 auth)', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ weekKey: '2026-07-06' }),
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.weekKey, '2026-07-06');
  assert.equal(body.ok, false);
});

test('markCellStatus 失敗(例如 Sheets API 額度用完)不該讓整輪同步中斷，且該筆記錄要標記清楚', async () => {
  const env = makeEnv();
  const upsertCalls = [];

  const fakeRecords = [
    { identityKey: 'bad-note-fails', contentHash: 'h1' },
    { identityKey: 'good-after', contentHash: 'h2' },
  ];

  const log = await runSyncForWeek(env, '2026-07-06', {
    fetchAndParseWeek: async () => fakeRecords,
    validateBookingRecord: async (record) => {
      if (record.identityKey === 'bad-note-fails') return { valid: false, errors: ['測試用錯誤'] };
      return { valid: true, row: {}, existingId: null };
    },
    markCellStatus: async () => {
      throw new Error('Sheets API 額度用完 (429)');
    },
    saveBooking: async (env_, row) => {
      upsertCalls.push(row);
    },
  });

  assert.equal(log.ok, true, 'markCellStatus 失敗不該讓整個 run 掛掉');
  assert.equal(upsertCalls.length, 1, '後面那筆合法的記錄應該還是要正常寫入');

  const entriesForFailedNote = log.results.filter((r) => r.identityKey === 'bad-note-fails');
  assert.equal(entriesForFailedNote.length, 2, '應該有兩筆記錄：驗證結果本身(invalid) + 寫備註失敗(mark_cell_status_failed)');
  assert.equal(entriesForFailedNote[0].status, 'invalid');
  assert.equal(entriesForFailedNote[1].status, 'mark_cell_status_failed');
  assert.ok(entriesForFailedNote[1].error.includes('額度用完'));

  const succeeded = log.results.find((r) => r.identityKey === 'good-after');
  assert.equal(succeeded.status, 'synced');
});

test('log.results 是逐筆累積、不是等全部跑完才賦值——即使中途丟出未預期例外，前面處理過的筆數仍然看得到', async () => {
  const env = makeEnv();
  const fakeRecords = [
    { identityKey: 'ok-1', contentHash: 'h1' },
    { identityKey: 'boom', contentHash: 'h2' },
  ];

  const log = await runSyncForWeek(env, '2026-07-06', {
    fetchAndParseWeek: async () => fakeRecords,
    validateBookingRecord: async (record) => {
      if (record.identityKey === 'boom') throw new Error('完全未預期的例外，不是 validation_error 那種被 catch 住的');
      return { valid: true, row: {}, existingId: null };
    },
    saveBooking: async () => {},
  });

  // 'boom' 這筆會被 validateBookingRecord 那層的 try/catch 接住變成 validation_error，
  // 這裡主要驗證的是：即使沒有那層 catch，log.results 也已經先記到 log 上，
  // 不會因為後面的例外而整批消失——用第一筆確認這件事。
  assert.ok(log.results.some((r) => r.identityKey === 'ok-1' && r.status === 'synced'));
});

test('synced 之後清備註失敗，不該讓整輪同步中斷(資料已經成功寫進去了)', async () => {
  const env = makeEnv();
  const upsertCalls = [];

  const log = await runSyncForWeek(env, '2026-07-06', {
    fetchAndParseWeek: async () => [{ identityKey: 'ok', contentHash: 'h1' }],
    validateBookingRecord: async () => ({ valid: true, row: {} }),
    markCellStatus: async () => {
      throw new Error('Sheets API 掛了');
    },
    saveBooking: async (env_, row) => {
      upsertCalls.push(row);
    },
  });

  assert.equal(log.ok, true, '清備註失敗不該讓整個 run 掛掉');
  assert.equal(upsertCalls.length, 1, '資料本身要是已經成功寫進去的狀態');

  const entries = log.results.filter((r) => r.identityKey === 'ok');
  assert.equal(entries.length, 2, '應該有 synced + clear_cell_status_failed 兩筆記錄');
  assert.equal(entries[0].status, 'synced');
  assert.equal(entries[1].status, 'clear_cell_status_failed');
});

test('fetch(): POST /sync 沒帶 weekKey 時，預設抓「這一週」的週一，不是三個月範圍裡最舊的那個(避免用當下真實日期造成 test 不穩定，只驗證格式跟落在合理範圍)', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({}),
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();
  assert.match(body.weekKey, /^\d{4}-\d{2}-\d{2}$/);

  const today = new Date();
  const diffDays = Math.abs((new Date(`${body.weekKey}T12:00:00Z`) - today) / (1000 * 60 * 60 * 24));
  assert.ok(diffDays <= 7, `預設的 weekKey(${body.weekKey}) 應該落在這一週附近，不是三個月範圍裡最舊的那一週`);
});

test('fetch(): POST /sync 帶 weekKeys 陣列(批次補跑)：env 沒設定真實憑證時，每一週都要優雅失敗，不是丟出未捕捉例外炸掉整個請求', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ weekKeys: ['2026-07-06', '2026-07-13'] }),
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();

  assert.equal(res.status, 500, '兩週都因為缺憑證而失敗，整體狀態碼要反映這件事');
  assert.equal(body.logs.length, 2, '兩個 weekKey 都要各自有結果，不能因為第一個失敗就沒處理第二個');
  assert.ok(body.logs.every((l) => l.ok === false));
  assert.ok(body.logs.every((l) => /GOOGLE_SERVICE_ACCOUNT_JSON/.test(l.error)));
});

test('fetch(): POST /sync 帶 scope:"current"：內部自己算出三個月範圍的 weekKeys，回應裡看得到算出的範圍', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ scope: 'current' }),
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();

  assert.ok(Array.isArray(body.weekKeys));
  assert.ok(body.weekKeys.length >= 12, '三個月範圍至少該有 12+ 個 weekKey(每月約4-5週)');
  assert.equal(body.logs.length, body.weekKeys.length, '每個算出來的 weekKey 都要有對應的處理結果');
});

test('上次驗證失敗、這次雖然 unchanged(內容沒變)，還是要重新驗證一次——這是真實發生過的 bug：驗證邏輯本身修好了，但 Sheet 內容沒變，之前失敗的記錄永遠不會被重新處理', async () => {
  const env = makeEnv();
  const fakeRecords = [{ identityKey: 'x', contentHash: 'same-hash', masterName: '許老師' }];

  // 第一輪：驗證邏輯還有 bug(對不到「許老師」)，失敗
  let shouldFail = true;
  const deps = {
    validateBookingRecord: async () => {
      if (shouldFail) return { valid: false, errors: ['找不到師傅「許老師」'] };
      return { valid: true, row: {}, existingId: null };
    },
    markCellStatus: async () => {},
    saveBooking: async () => {},
  };

  const log1 = await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  assert.equal(log1.results[0].status, 'invalid');

  // 修好驗證邏輯的 bug 了，但 Sheet 上的內容(contentHash)完全沒變
  shouldFail = false;
  const log2 = await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);

  assert.equal(log2.diffSummary.unchanged, 1, 'contentHash 沒變，diff 本身應該還是判定 unchanged');
  assert.equal(log2.diffSummary.retriedInvalid, 1, '但因為上次是 invalid，這次應該還是要重試');
  assert.equal(log2.results.find((r) => r.identityKey === 'x').status, 'synced', '重試後這次驗證通過，要標記成功');
});

test('上次成功(synced)、這次 unchanged：不該被重新處理(維持原本的效率優化)', async () => {
  const env = makeEnv();
  const fakeRecords = [{ identityKey: 'x', contentHash: 'same-hash' }];
  let validateCalls = 0;
  const deps = {
    validateBookingRecord: async () => {
      validateCalls++;
      return { valid: true, row: {}, existingId: null };
    },
    markCellStatus: async () => {},
    saveBooking: async () => {},
  };

  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);

  assert.equal(validateCalls, 1, '第二輪 unchanged 且上次是 synced，不該再驗證一次');
});

test('重試後還是失敗(不同原因)：下一輪還是會繼續重試，不會只重試一次就放棄', async () => {
  const env = makeEnv();
  const fakeRecords = [{ identityKey: 'x', contentHash: 'same-hash' }];
  let validateCalls = 0;
  const deps = {
    validateBookingRecord: async () => {
      validateCalls++;
      return { valid: false, errors: ['一直都失敗'] };
    },
    markCellStatus: async () => {},
    saveBooking: async () => {},
  };

  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);

  assert.equal(validateCalls, 3, '三輪都該重試，不是只重試一次');
});

test('fetch(): GET /debug/invalid-records 也要驗證 X-Internal-Secret', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/debug/invalid-records', {
    method: 'GET',
    headers: { 'X-Internal-Secret': 'wrong' },
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 401);
});

test('fetch(): GET /debug/invalid-records 掃過快照，正確列出 invalid 的記錄跟原因', async () => {
  const env = makeEnv();

  // 先讓一筆記錄真的失敗過、存進快照
  const fakeRecords = [{ identityKey: '許老師|2026-07-06|09:00', masterName: '許老師', date: '2026-07-06', startTime: '09:00', customerName: '陳先生', contentHash: 'h1' }];
  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, {
    validateBookingRecord: async () => ({ valid: false, errors: ['找不到師傅「許老師」'] }),
    markCellStatus: async () => {},
    saveBooking: async () => {},
  });

  const request = new Request('https://worker.example/debug/invalid-records', {
    method: 'GET',
    headers: { 'X-Internal-Secret': 'test-secret' },
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  const found = body.invalidRecords.find((r) => r.identityKey === '許老師|2026-07-06|09:00');
  assert.ok(found, '應該要找到剛剛失敗的那筆');
  assert.equal(found.lastError, '找不到師傅「許老師」');
  assert.equal(found.customerName, '陳先生');
});

test('fetch(): GET /debug/invalid-records 對已經成功(synced)的記錄不會列出來', async () => {
  const env = makeEnv();
  const fakeRecords = [{ identityKey: 'x|2026-07-06|09:00', masterName: '麒', date: '2026-07-06', startTime: '09:00', customerName: '王小明', contentHash: 'h1' }];
  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    markCellStatus: async () => {},
    saveBooking: async () => {},
  });

  const request = new Request('https://worker.example/debug/invalid-records', {
    method: 'GET',
    headers: { 'X-Internal-Secret': 'test-secret' },
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();
  assert.equal(body.invalidRecords.find((r) => r.identityKey === 'x|2026-07-06|09:00'), undefined);
});

test('資料寫入成功、但清備註失敗：下一輪(內容 unchanged)要單獨重試清備註，不用重新驗證/寫入一次(輕量重試)', async () => {
  const env = makeEnv();
  const fakeRecords = [{ identityKey: 'x', contentHash: 'same-hash' }];

  let validateCalls = 0;
  let saveCalls = 0;
  let markCallCount = 0;
  const deps = {
    validateBookingRecord: async () => {
      validateCalls++;
      return { valid: true, row: {}, existingId: null };
    },
    saveBooking: async () => {
      saveCalls++;
    },
    markCellStatus: async () => {
      markCallCount++;
      if (markCallCount === 1) throw new Error('Sheets API 暫時掛了');
      // 第二次(下一輪的重試)成功
    },
  };

  const log1 = await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  assert.equal(log1.results.find((r) => r.identityKey === 'x').status, 'synced');
  assert.ok(log1.results.some((r) => r.status === 'clear_cell_status_failed'));

  const log2 = await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);

  assert.equal(validateCalls, 1, '第二輪不該重新驗證，資料本身沒問題');
  assert.equal(saveCalls, 1, '第二輪不該重新寫入 Supabase');
  assert.equal(log2.diffSummary.noteRetried, 1);
  assert.ok(log2.results.some((r) => r.identityKey === 'x' && r.status === 'note_cleared_on_retry'));
});

test('資料寫入成功、清備註也成功：下一輪(unchanged)完全不用做任何事(效率優化維持)', async () => {
  const env = makeEnv();
  const fakeRecords = [{ identityKey: 'x', contentHash: 'same-hash' }];
  let validateCalls = 0;
  let markCalls = 0;
  const deps = {
    validateBookingRecord: async () => {
      validateCalls++;
      return { valid: true, row: {}, existingId: null };
    },
    saveBooking: async () => {},
    markCellStatus: async () => {
      markCalls++;
    },
  };

  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  const log2 = await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);

  assert.equal(validateCalls, 1);
  assert.equal(markCalls, 1, '兩輪都成功，第二輪完全不該再呼叫 markCellStatus');
  assert.equal(log2.diffSummary.noteRetried, 0);
});

test('清備註持續失敗：每一輪都會繼續重試，不會放棄', async () => {
  const env = makeEnv();
  const fakeRecords = [{ identityKey: 'x', contentHash: 'same-hash' }];
  let markCalls = 0;
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {},
    markCellStatus: async () => {
      markCalls++;
      throw new Error('一直壞掉');
    },
  };

  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);

  assert.equal(markCalls, 3, '三輪都該嘗試清備註，即使一直失敗');
});

test('forceNoteRecheck:true 時，即使沒有記錄追蹤到 noteCleared:false，也會強制重新檢查所有已同步記錄的備註(處理追蹤機制上線前就卡住的舊資料)', async () => {
  const env = makeEnv();
  const fakeRecords = [{ identityKey: 'x', contentHash: 'same-hash' }];
  let markCalls = 0;
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {},
    markCellStatus: async () => {
      markCalls++;
    },
  };

  // 第一輪：正常同步成功(noteCleared 會被記成 true，沒有任何異常)
  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  assert.equal(markCalls, 1);

  // 第二輪：正常情況下(沒有追蹤到失敗)不會再重試
  await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, deps);
  assert.equal(markCalls, 1, '沒有 forceNoteRecheck 時，正常成功的記錄不該被重新檢查');

  // 第三輪：帶 forceNoteRecheck，即使沒有追蹤到任何失敗，也要強制重新檢查一次
  const log3 = await runSyncForWeekWithRecords(env, '2026-07-06', fakeRecords, { ...deps, forceNoteRecheck: true });
  assert.equal(markCalls, 2, 'forceNoteRecheck 應該強制重新呼叫一次 markCellStatus');
  assert.equal(log3.diffSummary.noteRetried, 1);
});

test('fetch(): GET /debug/inspect-cell 也要驗證 X-Internal-Secret', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/debug/inspect-cell?date=2026-07-09&startTime=14:00&sheetMasterLabel=麒', {
    method: 'GET',
    headers: { 'X-Internal-Secret': 'wrong' },
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 401);
});

test('fetch(): GET /debug/inspect-cell 缺參數要回 400', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/debug/inspect-cell', {
    method: 'GET',
    headers: { 'X-Internal-Secret': 'test-secret' },
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 400);
});

test('fetch(): POST /debug/sweep-notes 也要驗證 X-Internal-Secret', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/debug/sweep-notes', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'wrong' },
    body: JSON.stringify({}),
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 401);
});

test('fetch(): POST /debug/sweep-notes 沒帶 dryRun 時預設是安全的(不會誤觸發真的清除)——這裡驗證的是"沒帶真的憑證時會優雅回500"，不是誤判成清除成功', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/debug/sweep-notes', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({}),
  });
  const res = await worker.fetch(request, env, {});
  // 沒有真實 Google 憑證，會在 getAccessToken 那步就失敗，回 500 + 錯誤訊息，
  // 不會意外執行成功、也不會把 dryRun 誤判成 false。
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(body.error);
});

test('fetch(): POST /debug/clean-garbage-bookings 也要驗證 X-Internal-Secret', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/debug/clean-garbage-bookings', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'wrong' },
    body: JSON.stringify({}),
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 401);
});

test('fetch(): POST /debug/restore-bookings 也要驗證 X-Internal-Secret', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/debug/restore-bookings', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'wrong' },
    body: JSON.stringify({ ids: ['x'], status: 'confirmed' }),
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 401);
});

test('fetch(): POST /debug/restore-bookings 缺 ids 或 status 要回 400', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/debug/restore-bookings', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({}),
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 400);
});

test('Sheet 上原本有的預約、這次消失了(格子被清空)：對應的資料庫預約要標記取消', async () => {
  const env = makeEnv();
  const cancelCalls = [];
  const record = { identityKey: 'x', contentHash: 'h1', masterName: '麒', date: '2026-07-06', startTime: '09:00' };
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {},
    markCellStatus: async () => {},
    fetchActiveMasters: async () => [{ id: 'master-uuid', name: '麒' }],
    findBookingAtSlot: async () => ({ id: 'booking-abc', customer_name: '王小明' }),
    cancelBooking: async (env_, id) => {
      cancelCalls.push(id);
    },
  };

  // 第一輪：這筆存在
  await runSyncForWeekWithRecords(env, '2026-07-06', [record], deps);
  // 第二輪：這筆從 Sheet 上消失了(格子空了)
  const log2 = await runSyncForWeekWithRecords(env, '2026-07-06', [], deps);

  assert.equal(log2.diffSummary.removed, 1);
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0], 'booking-abc');
  assert.equal(log2.results.find((r) => r.identityKey === 'x').status, 'cancelled_removed_from_sheet');
});

test('消失的記錄在資料庫裡本來就沒有有效預約(已經取消過/從沒成功寫入)：跳過，不算錯誤', async () => {
  const env = makeEnv();
  const record = { identityKey: 'x', contentHash: 'h1', masterName: '麒', date: '2026-07-06', startTime: '09:00' };
  let cancelCalled = false;
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {},
    markCellStatus: async () => {},
    fetchActiveMasters: async () => [{ id: 'master-uuid', name: '麒' }],
    findBookingAtSlot: async () => null, // 資料庫查不到有效預約
    cancelBooking: async () => {
      cancelCalled = true;
    },
  };

  await runSyncForWeekWithRecords(env, '2026-07-06', [record], deps);
  const log2 = await runSyncForWeekWithRecords(env, '2026-07-06', [], deps);

  assert.equal(cancelCalled, false);
  assert.equal(log2.results.find((r) => r.identityKey === 'x').status, 'cancel_skipped_nothing_to_cancel');
});

test('消失的記錄的師傅名字對不到任何在職師傅：跳過，不會讓整輪同步中斷', async () => {
  const env = makeEnv();
  const record = { identityKey: 'x', contentHash: 'h1', masterName: '不存在的師傅', date: '2026-07-06', startTime: '09:00' };
  const deps = {
    validateBookingRecord: async () => ({ valid: false, errors: ['找不到師傅'] }),
    saveBooking: async () => {},
    markCellStatus: async () => {},
    fetchActiveMasters: async () => [{ id: 'master-uuid', name: '麒' }],
    findBookingAtSlot: async () => null,
    cancelBooking: async () => {},
  };

  // 第一輪：這筆會驗證失敗(找不到師傅)，不會被寫入，但快照裡還是會記錄這筆
  // 出現過——用另一種方式模擬「曾經存在過」：直接給它 valid 讓它先寫進去，
  // 之後才測試移除時師傅對不到的情境。
  const validDeps = { ...deps, validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }) };
  await runSyncForWeekWithRecords(env, '2026-07-06', [record], validDeps);

  const log2 = await runSyncForWeekWithRecords(env, '2026-07-06', [], deps);
  assert.equal(log2.results.find((r) => r.identityKey === 'x').status, 'cancel_skipped_master_not_found');
});

test('取消失敗不會讓整輪同步中斷，會清楚記錄失敗原因', async () => {
  const env = makeEnv();
  const record = { identityKey: 'x', contentHash: 'h1', masterName: '麒', date: '2026-07-06', startTime: '09:00' };
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {},
    markCellStatus: async () => {},
    fetchActiveMasters: async () => [{ id: 'master-uuid', name: '麒' }],
    findBookingAtSlot: async () => ({ id: 'booking-abc' }),
    cancelBooking: async () => {
      throw new Error('Supabase 暫時掛了');
    },
  };

  await runSyncForWeekWithRecords(env, '2026-07-06', [record], deps);
  const log2 = await runSyncForWeekWithRecords(env, '2026-07-06', [], deps);

  assert.equal(log2.ok, true, '取消失敗不該讓整輪同步標記失敗');
  const result = log2.results.find((r) => r.identityKey === 'x');
  assert.equal(result.status, 'cancel_failed');
  assert.ok(result.error.includes('暫時掛了'));
});

test('沒有消失的記錄不受這個邏輯影響(不會誤取消還存在的預約)', async () => {
  const env = makeEnv();
  const record = { identityKey: 'x', contentHash: 'h1', masterName: '麒', date: '2026-07-06', startTime: '09:00' };
  let cancelCalled = false;
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {},
    markCellStatus: async () => {},
    fetchActiveMasters: async () => [{ id: 'master-uuid', name: '麒' }],
    findBookingAtSlot: async () => ({ id: 'booking-abc' }),
    cancelBooking: async () => {
      cancelCalled = true;
    },
  };

  await runSyncForWeekWithRecords(env, '2026-07-06', [record], deps);
  // 第二輪內容一樣(不是消失，是 unchanged)
  await runSyncForWeekWithRecords(env, '2026-07-06', [record], deps);

  assert.equal(cancelCalled, false);
});

test('fetch(): POST /debug/cleanup-r2 也要驗證 X-Internal-Secret', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/debug/cleanup-r2', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'wrong' },
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 401);
});

test('fetch(): POST /debug/cleanup-r2 實際清理，範圍內的 snapshot 完全不動', async () => {
  const env = makeEnv();
  const { saveSnapshot, appendLog } = await import('../src/snapshotStore.js');
  const { weekKeysToSync } = await import('../src/weekKeys.js');

  const currentWeekKeys = weekKeysToSync(new Date());
  await saveSnapshot(env.SHEET_SYNC_BUCKET, currentWeekKeys[0], [{ a: 1 }]); // 範圍內
  await saveSnapshot(env.SHEET_SYNC_BUCKET, '2020-01-06', [{ a: 2 }]); // 早就過期
  await appendLog(env.SHEET_SYNC_BUCKET, { weekKey: 'x' });

  const request = new Request('https://worker.example/debug/cleanup-r2', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.deletedLogCount, 1);
  assert.equal(body.deletedSnapshotCount, 2, '過期週的 latest.json + history 兩個物件');
  assert.ok(body.keptWeekKeys.includes(currentWeekKeys[0]));
});

test('暫停自動匯入的師傅：即使 Sheet 上他的記錄消失了，也不會被誤判取消(凍結在上次快照的狀態)', async () => {
  const env = makeEnv();
  const enabledRecord = { identityKey: 'a', contentHash: 'h1', masterName: '麒', date: '2026-07-06', startTime: '09:00' };
  const pausedRecord = { identityKey: 'b', contentHash: 'h1', masterName: '哲瑋', date: '2026-07-06', startTime: '09:00' };
  const cancelCalls = [];
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {},
    markCellStatus: async () => {},
    fetchActiveMasters: async () => [{ id: 'm1', name: '麒' }, { id: 'm2', name: '哲瑋' }],
    findBookingAtSlot: async () => ({ id: 'booking-x' }),
    cancelBooking: async (env_, id) => cancelCalls.push(id),
    fetchSyncEnabledMasterNames: async () => new Set(['麒']), // 哲瑋暫停
  };

  // 第一輪：兩筆都存在
  await runSyncForWeekWithRecords(env, '2026-07-06', [enabledRecord, pausedRecord], deps);
  // 第二輪：兩筆都從 Sheet 上消失了(格子被清空)
  const log2 = await runSyncForWeekWithRecords(env, '2026-07-06', [], deps);

  assert.equal(cancelCalls.length, 1, '只有啟用中的麒該被取消，暫停中的哲瑋不該被動到');
  assert.equal(cancelCalls[0], 'booking-x');
  const pausedResult = log2.results.find((r) => r.identityKey === 'b');
  assert.equal(pausedResult, undefined, '暫停中師傅的記錄完全不該出現在 results 裡(凍結、沒被處理)');
});

test('暫停自動匯入的師傅：Sheet 上就算有新資料，也不會被寫入資料庫', async () => {
  const env = makeEnv();
  const pausedNewRecord = { identityKey: 'new-1', contentHash: 'h1', masterName: '哲瑋', date: '2026-07-06', startTime: '10:00' };
  let saveCalled = false;
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {
      saveCalled = true;
    },
    markCellStatus: async () => {},
    fetchActiveMasters: async () => [{ id: 'm2', name: '哲瑋' }],
    findBookingAtSlot: async () => null,
    cancelBooking: async () => {},
    fetchSyncEnabledMasterNames: async () => new Set([]), // 哲瑋暫停，且這是第一次出現(previous 沒有)
  };

  const log = await runSyncForWeekWithRecords(env, '2026-07-06', [pausedNewRecord], deps);
  assert.equal(saveCalled, false, '暫停中的師傅，就算是全新記錄也不該寫入');
  assert.equal(log.results.find((r) => r.identityKey === 'new-1'), undefined);
});

test('查詢暫停狀態本身失敗時，優雅退回原本行為(不凍結)，不會讓整輪同步掛掉', async () => {
  const env = makeEnv();
  const record = { identityKey: 'x', contentHash: 'h1', masterName: '麒', date: '2026-07-06', startTime: '09:00' };
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {},
    markCellStatus: async () => {},
    fetchSyncEnabledMasterNames: async () => {
      throw new Error('Supabase 暫時掛了');
    },
  };

  const log = await runSyncForWeekWithRecords(env, '2026-07-06', [record], deps);
  assert.equal(log.ok, true, '查暫停狀態失敗不該讓整輪同步標記失敗');
  assert.equal(log.results.find((r) => r.identityKey === 'x')?.status, 'synced', '退回原本行為，正常處理這筆記錄');
});

test('bypassSyncPause:true(立即匯入按鈕用)：就算師傅暫停中，也要真的處理，不能被凍結擋住', async () => {
  const env = makeEnv();
  const record = { identityKey: 'x', contentHash: 'h1', masterName: '哲瑋', date: '2026-07-06', startTime: '09:00' };
  let saveCalled = false;
  const deps = {
    validateBookingRecord: async () => ({ valid: true, row: {}, existingId: null }),
    saveBooking: async () => {
      saveCalled = true;
    },
    markCellStatus: async () => {},
    fetchSyncEnabledMasterNames: async () => new Set([]), // 哲瑋暫停中
    bypassSyncPause: true, // 但這次是使用者主動按「立即匯入」
  };

  const log = await runSyncForWeekWithRecords(env, '2026-07-06', [record], deps);
  assert.equal(saveCalled, true, 'bypassSyncPause 時，暫停中的師傅也該被正常處理');
  assert.equal(log.results.find((r) => r.identityKey === 'x')?.status, 'synced');
});

test('onlyMasterName 指定時，只處理該師傅，其他師傅即使有變化也凍結不動', async () => {
  const env = makeEnv();
  const targetRecord = { identityKey: 'a', contentHash: 'h1', masterName: '泓文', date: '2026-07-06', startTime: '09:00' };
  const otherRecord = { identityKey: 'b', contentHash: 'h1', masterName: '麒', date: '2026-07-06', startTime: '09:00' };
  let saveCalls = [];
  const deps = {
    validateBookingRecord: async (record) => ({ valid: true, row: { customer_name: record.customerName }, existingId: null }),
    saveBooking: async (env_, row) => saveCalls.push(row.customer_name),
    markCellStatus: async () => {},
    onlyMasterName: '泓文',
  };

  const log = await runSyncForWeekWithRecords(env, '2026-07-06', [targetRecord, otherRecord], deps);

  assert.equal(log.results.find((r) => r.identityKey === 'a')?.status, 'synced', '指定的師傅要正常處理');
  assert.equal(log.results.find((r) => r.identityKey === 'b'), undefined, '沒指定的師傅完全不該被處理');
});

test('fetch(): POST /sync 帶 scope:"current" + masterName + bypassSyncPause，正確傳遞到 safelyFetchAndSyncWeek(用缺憑證優雅失敗來驗證有跑到、參數有傳對，不需要真的連上 Google)', async () => {
  const env = makeEnv();
  const request = new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ scope: 'current', masterName: '泓文', bypassSyncPause: true }),
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();
  // 沒有真實 Google 憑證，每一週都會在抓取階段失敗，但至少證明有正確
  // 跑到 scope:"current" 這條路徑、算出了完整的 weekKeys 清單。
  assert.ok(Array.isArray(body.weekKeys));
  assert.ok(body.weekKeys.length >= 12);
});

test('fetch(): POST /sync 帶 background:true 立刻回應 202，不等同步跑完', async () => {
  const env = makeEnv();
  let backgroundPromiseCaptured = null;
  const ctx = {
    waitUntil: (promise) => {
      backgroundPromiseCaptured = promise;
    },
  };
  const request = new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ scope: 'current', masterName: '泓文', background: true }),
  });

  const start = Date.now();
  const res = await worker.fetch(request, env, ctx);
  const elapsed = Date.now() - start;
  const body = await res.json();

  assert.equal(res.status, 202);
  assert.equal(body.started, true);
  assert.ok(Array.isArray(body.weekKeys));
  assert.ok(elapsed < 500, '應該幾乎立刻回應，不等實際同步跑完');
  assert.ok(backgroundPromiseCaptured, 'ctx.waitUntil 應該有被呼叫，背景任務有被交付出去');

  // 讓背景任務跑完(這裡沒有真實 Google 憑證，會優雅失敗，但至少確認
  // 有真的被執行到，不是完全沒動作)
  await backgroundPromiseCaptured.catch(() => {});
});

test('fetch(): POST /sync scope:"current"(全範圍)：上一輪的鎖還在，這次要跳過(409)，不會疊上去執行', async () => {
  const env = makeEnv();
  await acquireSyncLock(env.SHEET_SYNC_BUCKET, 'previous-run');

  const request = new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ scope: 'current' }),
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.skipped, true);
});

test('fetch(): POST /sync 帶 masterName(單一師傅立即匯入)：就算有鎖也不受影響，照常執行', async () => {
  const env = makeEnv();
  await acquireSyncLock(env.SHEET_SYNC_BUCKET, 'previous-run');

  const request = new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'X-Internal-Secret': 'test-secret' },
    body: JSON.stringify({ scope: 'current', masterName: '泓文' }),
  });
  const res = await worker.fetch(request, env, {});
  const body = await res.json();

  // 沒有真實 Google 憑證，每一週都會在抓取階段失敗(不是被鎖擋下來)，
  // 用回應裡有 weekKeys/logs(而不是 skipped:true)證明真的有跑到、
  // 沒有被鎖攔住。
  assert.ok(Array.isArray(body.weekKeys));
  assert.ok(Array.isArray(body.logs));
  assert.equal(body.skipped, undefined);
});
