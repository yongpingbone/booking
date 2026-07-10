import test from 'node:test';
import assert from 'node:assert/strict';
import { serialToDateString, serialToTimeString, dateStringToSerial } from '../src/sheetsSerial.js';

test('已知基準點：序列數字 25569 = 1970-01-01(Unix epoch，Excel/Sheets 系統的公認對照值)', () => {
  assert.equal(serialToDateString(25569), '1970-01-01');
});

test('序列數字轉日期：2026-07-01(獨立用 Python date 運算驗證過的序列數字 46204)', () => {
  assert.equal(serialToDateString(46204), '2026-07-01');
});

test('serialToTimeString: 0.5 = 中午 12:00', () => {
  assert.equal(serialToTimeString(0.5), '12:00');
});

test('serialToTimeString: 8:00 AM ≈ 0.333333', () => {
  assert.equal(serialToTimeString(8 / 24), '08:00');
});

test('serialToTimeString: 22:30(從實際 Sheet 確認過的最後一個時段)', () => {
  assert.equal(serialToTimeString(22.5 / 24), '22:30');
});

test('serialToTimeString: 帶日期的序列數字(整數+小數)也要正確算出時間部分', () => {
  // 46204.354166... = 2026-07-01 08:30
  assert.equal(serialToTimeString(46204 + 8.5 / 24), '08:30');
});

test('日期字串轉序列數字，再轉回去要一致(round-trip)', () => {
  const serial = dateStringToSerial('2026-07-10');
  assert.equal(serialToDateString(serial), '2026-07-10');
});

test('dateStringToSerial: 已知基準點 1970-01-01 = 25569', () => {
  assert.equal(dateStringToSerial('1970-01-01'), 25569);
});

test('非數字輸入要丟錯，不能默默回傳 NaN 或奇怪的字串', () => {
  assert.throws(() => serialToDateString('not a number'), TypeError);
  assert.throws(() => serialToTimeString(undefined), TypeError);
});
