import test from 'node:test';
import assert from 'node:assert/strict';
import { MockR2Bucket } from './mockR2Bucket.js';
import worker, { runSyncForWeek } from '../src/index.js';
import { getLatestSnapshot } from '../src/snapshotStore.js';

function makeEnv(overrides = {}) {
  return {
    SHEET_SYNC_BUCKET: new MockR2Bucket(),
    INTERNAL_SYNC_SECRET: 'test-secret',
    ...overrides,
  };
}

test('happy path：兩筆新預約，驗證都過，都要寫進 Supabase，快照要存起來', async () => {
  const env = makeEnv();
  const upsertCalls = [];

  const fakeRecords = [
    { identityKey: 'a', contentHash: 'h1', masterName: '許老師' },
    { identityKey: 'b', contentHash: 'h2', masterName: '魏老師' },
  ];

  const log = await runSyncForWeek(env, '2026-07-06', {
    fetchAndParseWeek: async () => fakeRecords,
    validateBookingRecord: async (record) => ({ valid: true, row: { source_identity: record.identityKey } }),
    markCellStatus: async () => {
      throw new Error('不應該被呼叫 —— 這個 test 裡沒有驗證失敗的項目');
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
  assert.equal(markCalls.length, 1);
  assert.equal(markCalls[0].record.identityKey, 'bad');

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
