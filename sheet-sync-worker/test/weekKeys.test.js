import test from 'node:test';
import assert from 'node:assert/strict';
import { weekKeysToSync, mondayOf, taipeiDateString } from '../src/weekKeys.js';

test('taipeiDateString: UTC 傍晚以後，台灣時間已經是隔天，要抓到隔天日期', () => {
  // 2026-07-09 20:00 UTC = 2026-07-10 04:00 台灣時間
  const result = taipeiDateString(new Date('2026-07-09T20:00:00Z'));
  assert.equal(result, '2026-07-10');
});

test('taipeiDateString: UTC 剛過午夜，台灣時間還是前一天早上快中午', () => {
  // 2026-07-10 02:00 UTC = 2026-07-10 10:00 台灣時間 → 還是同一天，這個 case 主要是確認不要多加一天
  const result = taipeiDateString(new Date('2026-07-10T02:00:00Z'));
  assert.equal(result, '2026-07-10');
});

test('mondayOf: 星期一本身 → 回傳自己', () => {
  // 2026-07-06 是星期一
  assert.equal(mondayOf('2026-07-06'), '2026-07-06');
});

test('mondayOf: 星期日 → 回傳前一個星期一(往前推6天，不是往後推)', () => {
  // 2026-07-12 是星期日，屬於 07-06 那週
  assert.equal(mondayOf('2026-07-12'), '2026-07-06');
});

test('mondayOf: 星期三 → 回傳同一週的星期一', () => {
  // 2026-07-08 是星期三
  assert.equal(mondayOf('2026-07-08'), '2026-07-06');
});

test('mondayOf: 跨月的週 也要算對(星期一在上個月)', () => {
  // 2026-08-03 是星期一；2026-08-01 是星期六，屬於 2026-07-27 那週
  assert.equal(mondayOf('2026-08-01'), '2026-07-27');
});

test('weekKeysToSync: 涵蓋上個月、當月、下個月三個月完整範圍', () => {
  // 2026-07-11 是週六，屬於 2026-07-06 那週。上月=6月、當月=7月、下月=8月。
  const keys = weekKeysToSync(new Date('2026-07-11T12:00:00Z'));
  assert.deepEqual(keys, [
    '2026-06-01',
    '2026-06-08',
    '2026-06-15',
    '2026-06-22',
    '2026-06-29',
    '2026-07-06',
    '2026-07-13',
    '2026-07-20',
    '2026-07-27',
    '2026-08-03',
    '2026-08-10',
    '2026-08-17',
    '2026-08-24',
    '2026-08-31',
  ]);
});

test('weekKeysToSync: 1月時「上個月」要正確跨年到去年12月', () => {
  const keys = weekKeysToSync(new Date('2026-01-05T12:00:00Z'));
  assert.equal(keys[0], '2025-12-01', '上個月要是去年12月，不是月份數字變成0或負數');
  assert.ok(keys.includes('2026-01-05'), '要包含當月(1月)的週');
  assert.ok(keys.some((k) => k.startsWith('2026-02')), '要包含下個月(2月)的週');
});

test('weekKeysToSync: 12月時「下個月」要正確跨年到明年1月', () => {
  const keys = weekKeysToSync(new Date('2026-12-20T12:00:00Z'));
  const lastKey = keys[keys.length - 1];
  assert.ok(lastKey.startsWith('2027-01'), '最後一個 weekKey 要落在明年1月，不是月份數字變成13');
  assert.ok(keys.some((k) => k.startsWith('2026-11')), '要包含上個月(11月)的週');
});

test('weekKeysToSync: 結果由舊到新排序、沒有重複', () => {
  const keys = weekKeysToSync(new Date('2026-07-11T12:00:00Z'));
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
  assert.equal(new Set(keys).size, keys.length);
});
