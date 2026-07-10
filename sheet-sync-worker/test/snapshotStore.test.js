import test from 'node:test';
import assert from 'node:assert/strict';
import { MockR2Bucket } from './mockR2Bucket.js';
import {
  getLatestSnapshot,
  saveSnapshot,
  appendLog,
  listLogs,
  latestKey,
  historyKey,
} from '../src/snapshotStore.js';

test('還沒同步過的 week → getLatestSnapshot 回傳 null，不是丟錯', async () => {
  const bucket = new MockR2Bucket();
  const result = await getLatestSnapshot(bucket, '2026-07-06');
  assert.equal(result, null);
});

test('saveSnapshot 之後可以讀回一樣的內容，且同時寫了 latest 跟 history 兩份', async () => {
  const bucket = new MockR2Bucket();
  const records = [{ identityKey: 'a', contentHash: 'h1' }];
  await saveSnapshot(bucket, '2026-07-06', records, '2026-07-10T03:00:00.000Z');

  const latest = await getLatestSnapshot(bucket, '2026-07-06');
  assert.deepEqual(latest.records, records);
  assert.equal(latest.savedAt, '2026-07-10T03:00:00.000Z');

  assert.ok(bucket.store.has(latestKey('2026-07-06')));
  assert.ok(bucket.store.has(historyKey('2026-07-06', '2026-07-10T03:00:00.000Z')));
});

test('saveSnapshot 兩次，latest 只保留最新一次，但 history 兩份都在(供追查)', async () => {
  const bucket = new MockR2Bucket();
  await saveSnapshot(bucket, '2026-07-06', [{ identityKey: 'a', contentHash: 'h1' }], '2026-07-10T03:00:00.000Z');
  await saveSnapshot(bucket, '2026-07-06', [{ identityKey: 'a', contentHash: 'h2' }], '2026-07-10T04:00:00.000Z');

  const latest = await getLatestSnapshot(bucket, '2026-07-06');
  assert.equal(latest.records[0].contentHash, 'h2');

  const logs = await bucket.list({ prefix: 'snapshots/2026-07-06/history/' });
  assert.equal(logs.objects.length, 2);
});

test('formatVersion 對不上目前程式預期的版本 → 明確丟錯，不要默默照舊格式解析', async () => {
  const bucket = new MockR2Bucket();
  await bucket.put(latestKey('2026-07-06'), JSON.stringify({ formatVersion: 99, records: [] }));
  await assert.rejects(() => getLatestSnapshot(bucket, '2026-07-06'), /formatVersion/);
});

test('weekKey 帶不安全字元(空白、斜線)要直接丟錯，不要讓它變成奇怪的 R2 key', async () => {
  const bucket = new MockR2Bucket();
  await assert.rejects(() => saveSnapshot(bucket, 'week 6', []), /weekKey 不合法/);
  await assert.rejects(() => saveSnapshot(bucket, '2026/07/06', []), /weekKey 不合法/);
});

test('appendLog + listLogs: log 依時間新到舊排序', async () => {
  const bucket = new MockR2Bucket();
  await appendLog(bucket, { weekKey: '2026-07-06', runId: 'run-1' }, '2026-07-10T03:00:00.000Z');
  await appendLog(bucket, { weekKey: '2026-07-06', runId: 'run-2' }, '2026-07-10T04:00:00.000Z');

  const keys = await listLogs(bucket, { date: '2026-07-10' });
  assert.equal(keys.length, 2);
  assert.ok(keys[0].includes('run-2'), '最新的一筆應該排最前面');
  assert.ok(keys[1].includes('run-1'));
});

test('listLogs: 指定日期時不會撈到其他天的 log', async () => {
  const bucket = new MockR2Bucket();
  await appendLog(bucket, { runId: 'yesterday' }, '2026-07-09T23:59:00.000Z');
  await appendLog(bucket, { runId: 'today' }, '2026-07-10T00:01:00.000Z');

  const keys = await listLogs(bucket, { date: '2026-07-10' });
  assert.equal(keys.length, 1);
  assert.ok(keys[0].includes('today'));
});
