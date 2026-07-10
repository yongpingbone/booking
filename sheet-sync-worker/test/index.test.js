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
    upsertBooking: async (env_, row) => {
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
    upsertBooking: async (env_, row) => {
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
    upsertBooking: async () => {
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
