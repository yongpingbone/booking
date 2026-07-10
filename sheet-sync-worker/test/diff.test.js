import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, buildIdentityKey, hashContent } from '../src/diff.js';

function rec(identityKey, contentHash, extra = {}) {
  return { identityKey, contentHash, ...extra };
}

test('第一次同步：沒有舊快照(null)，全部視為新增', () => {
  const current = [rec('a', 'h1'), rec('b', 'h2')];
  const result = diffSnapshots(null, current);
  assert.deepEqual(result.added.map((r) => r.identityKey).sort(), ['a', 'b']);
  assert.equal(result.changed.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.unchanged.length, 0);
});

test('內容雜湊沒變 → unchanged，不算異動', () => {
  const previous = [rec('a', 'h1')];
  const current = [rec('a', 'h1')];
  const result = diffSnapshots(previous, current);
  assert.equal(result.unchanged.length, 1);
  assert.equal(result.changed.length, 0);
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
});

test('同一個 identityKey、雜湊不同 → changed，且帶著前後兩筆內容', () => {
  const previous = [rec('a', 'h1', { note: 'old' })];
  const current = [rec('a', 'h2', { note: 'new' })];
  const result = diffSnapshots(previous, current);
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].previous.note, 'old');
  assert.equal(result.changed[0].current.note, 'new');
});

test('舊快照有、這次讀不到 → removed(師傅把預約從 Sheet 上刪掉/清空)', () => {
  const previous = [rec('a', 'h1'), rec('b', 'h2')];
  const current = [rec('a', 'h1')];
  const result = diffSnapshots(previous, current);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].identityKey, 'b');
});

test('新增、異動、刪除、不變 同時發生，四種分類要各自正確', () => {
  const previous = [
    rec('keep', 'h1'),
    rec('change-me', 'h-old'),
    rec('will-be-removed', 'h1'),
  ];
  const current = [
    rec('keep', 'h1'),
    rec('change-me', 'h-new'),
    rec('brand-new', 'h1'),
  ];
  const result = diffSnapshots(previous, current);
  assert.deepEqual(result.added.map((r) => r.identityKey), ['brand-new']);
  assert.deepEqual(result.changed.map((c) => c.current.identityKey), ['change-me']);
  assert.deepEqual(result.removed.map((r) => r.identityKey), ['will-be-removed']);
  assert.deepEqual(result.unchanged.map((r) => r.identityKey), ['keep']);
});

test('currentRecords 不是陣列(例如忘記傳、傳成 undefined)要直接丟錯，不能默默當成沒資料', () => {
  assert.throws(() => diffSnapshots([], undefined), TypeError);
  assert.throws(() => diffSnapshots([], null), TypeError);
});

test('currentRecords 內有重複 identityKey 要丟錯，不能悄悄互相覆蓋掉一筆', () => {
  const current = [rec('dup', 'h1'), rec('dup', 'h2')];
  assert.throws(() => diffSnapshots(null, current), /重複的 identityKey/);
});

test('previousRecords 內有重複 identityKey 也要丟錯(理論上不該發生，但要能提早發現快照本身壞掉)', () => {
  const previous = [rec('dup', 'h1'), rec('dup', 'h2')];
  assert.throws(() => diffSnapshots(previous, []), /重複的 identityKey/);
});

test('空的 currentRecords 陣列(這週 Sheet 目前沒任何預約) + 有舊快照 → 全部變成 removed', () => {
  const previous = [rec('a', 'h1'), rec('b', 'h2')];
  const result = diffSnapshots(previous, []);
  assert.equal(result.removed.length, 2);
  assert.equal(result.added.length, 0);
});

test('buildIdentityKey: 同樣三個欄位要產生同樣的 key，且會 trim 掉多餘空白', () => {
  const k1 = buildIdentityKey({ masterName: '許老師', date: '2026-07-13', startTime: '09:00' });
  const k2 = buildIdentityKey({ masterName: ' 許老師 ', date: '2026-07-13', startTime: '09:00' });
  assert.equal(k1, k2);
});

test('buildIdentityKey: 缺欄位要丟錯', () => {
  assert.throws(() => buildIdentityKey({ masterName: '許老師', date: '2026-07-13', startTime: '' }));
});

test('hashContent: 同樣內容(即使欄位順序不同)要算出同一個雜湊', async () => {
  const h1 = await hashContent({ customerName: '王小明', startTime: '09:00', isNewCustomer: true });
  const h2 = await hashContent({ isNewCustomer: true, startTime: '09:00', customerName: '王小明' });
  assert.equal(h1, h2);
});

test('hashContent: 內容不同要算出不同雜湊', async () => {
  const h1 = await hashContent({ customerName: '王小明' });
  const h2 = await hashContent({ customerName: '王小華' });
  assert.notEqual(h1, h2);
});
