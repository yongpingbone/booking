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

test('weekKeysToSync: 預設(0 週回顧 + 4 週往後) 回傳 5 個 weekKey，由舊到新', () => {
  // 用固定時間點測試，2026-07-10 是星期五，屬於 2026-07-06 那週
  const keys = weekKeysToSync(new Date('2026-07-10T04:00:00Z'));
  assert.deepEqual(keys, ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03']);
});

test('weekKeysToSync: weeksBack=1 時，第一個 key 是上週一', () => {
  const keys = weekKeysToSync(new Date('2026-07-10T04:00:00Z'), { weeksBack: 1, weeksAhead: 1 });
  assert.deepEqual(keys, ['2026-06-29', '2026-07-06', '2026-07-13']);
});

test('weekKeysToSync: weeksAhead=0 時只回傳這一週', () => {
  const keys = weekKeysToSync(new Date('2026-07-10T04:00:00Z'), { weeksBack: 0, weeksAhead: 0 });
  assert.deepEqual(keys, ['2026-07-06']);
});
