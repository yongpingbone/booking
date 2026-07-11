import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCellReference, markCellStatus } from '../src/sheetWriter.js';

test('resolveCellReference: 7/1(週三，該月第一週)8:00 —— 對照真實 Sheet 資料驗證過的座標', () => {
  // 真實資料裡確認過：7月-泓文 分頁，7/1 在第一個週區塊(表頭在0-indexed row1)、
  // 週三欄(0-indexed col4)、8:00 是該區塊第一個時段列(0-indexed row2)
  const ref = resolveCellReference({ date: '2026-07-01', startTime: '08:00', sheetMasterLabel: '泓文' });
  assert.equal(ref.sheetTitle, '7月-泓文');
  assert.equal(ref.rowIndex, 2);
  assert.equal(ref.colIndex, 4);
});

test('resolveCellReference: 7/8(下一個週三)8:00 —— 第二個週區塊，列要往下推 34', () => {
  const ref = resolveCellReference({ date: '2026-07-08', startTime: '08:00', sheetMasterLabel: '泓文' });
  assert.equal(ref.rowIndex, 2 + 34);
  assert.equal(ref.colIndex, 4);
});

test('resolveCellReference: 同一天不同時段，欄位不變、列位往下對應時段數', () => {
  const t0800 = resolveCellReference({ date: '2026-07-01', startTime: '08:00', sheetMasterLabel: '泓文' });
  const t0830 = resolveCellReference({ date: '2026-07-01', startTime: '08:30', sheetMasterLabel: '泓文' });
  const t0900 = resolveCellReference({ date: '2026-07-01', startTime: '09:00', sheetMasterLabel: '泓文' });
  assert.equal(t0830.rowIndex, t0800.rowIndex + 1);
  assert.equal(t0900.rowIndex, t0800.rowIndex + 2);
  assert.equal(t0830.colIndex, t0800.colIndex);
});

test('resolveCellReference: 月份剛好從週日開始(該月第一週不會有跨月空白)', () => {
  // 2026-11-01 是星期日
  const ref = resolveCellReference({ date: '2026-11-01', startTime: '08:00', sheetMasterLabel: '麒' });
  assert.equal(ref.sheetTitle, '11月-麒');
  assert.equal(ref.rowIndex, 2); // 第一個區塊
  assert.equal(ref.colIndex, 1); // 週日 = col1(0-indexed)
});

test('resolveCellReference: 月份從週六開始(該月第一週只有週六一天在區塊內)', () => {
  // 2026-08-01 是星期六
  const ref = resolveCellReference({ date: '2026-08-01', startTime: '08:00', sheetMasterLabel: '治' });
  assert.equal(ref.sheetTitle, '8月-治');
  assert.equal(ref.rowIndex, 2); // 還是屬於第一個區塊(該區塊的週日在7月)
  assert.equal(ref.colIndex, 7); // 週六 = col7(0-indexed)
});

test('resolveCellReference: 時間超出 8:00~22:30 範圍要丟清楚的錯誤', () => {
  assert.throws(
    () => resolveCellReference({ date: '2026-07-01', startTime: '07:30', sheetMasterLabel: '泓文' }),
    /超出 Sheet 涵蓋的時段範圍/
  );
  assert.throws(() => resolveCellReference({ date: '2026-07-01', startTime: '23:00', sheetMasterLabel: '泓文' }));
});

test('resolveCellReference: 非整點/半點的時間(例如 8:15)要丟錯，不要算出奇怪的位置', () => {
  assert.throws(() => resolveCellReference({ date: '2026-07-01', startTime: '08:15', sheetMasterLabel: '泓文' }));
});

test('markCellStatus: 會算出座標、換 token、呼叫 setCellNote，note 內容包含訊息', async () => {
  const calls = [];
  await markCellStatus(
    {},
    { date: '2026-07-01', startTime: '08:00', sheetMasterLabel: '泓文' },
    { type: 'invalid', message: '找不到師傅「泓文」' },
    {
      getAccessToken: async () => 'fake-token',
      setCellNote: async (env, params) => {
        calls.push(params);
      },
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sheetTitle, '7月-泓文');
  assert.equal(calls[0].rowIndex, 2);
  assert.equal(calls[0].colIndex, 4);
  assert.equal(calls[0].accessToken, 'fake-token');
  assert.ok(calls[0].note.includes('找不到師傅「泓文」'));
  assert.ok(calls[0].note.includes('同步失敗'));
});

test('markCellStatus: invalid 寫錯誤備註，synced 清空備註(不是寫「已同步」文字)', async () => {
  const notes = [];
  const deps = {
    getAccessToken: async () => 'x',
    setCellNote: async (env, { note }) => notes.push(note),
  };
  const record = { date: '2026-07-01', startTime: '08:00', sheetMasterLabel: '泓文' };
  await markCellStatus({}, record, { type: 'invalid', message: '格式錯誤' }, deps);
  await markCellStatus({}, record, { type: 'synced' }, deps);
  assert.ok(notes[0].includes('同步失敗'));
  assert.equal(notes[1], null, 'synced 應該清空備註，不是寫新文字');
});
