import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMonth } from '../src/reconcile.js';

const MASTERS = [
  { id: 'm-hongwen', name: '泓文' },
  { id: 'm-qi', name: '麒' },
];

function sheetRecord(masterName, date, startTime) {
  return { masterName, date, startTime, customerName: 'x', identityKey: `${masterName}|${date}|${startTime}` };
}

function dbBooking(id, masterId, date, startTime, customerName, bookingSource = 'internal') {
  return { id, master_id: masterId, date, start_time: `${startTime}:00`, customer_name: customerName, booking_source: bookingSource };
}

function deps({ sheetRecords = [], masters = MASTERS, dbBookings = [], cancelCalls = [] } = {}) {
  return {
    fetchAndParseMonth: async () => sheetRecords,
    fetchActiveMasters: async () => masters,
    fetchBookingsInMonth: async () => dbBookings,
    cancelBooking: async (env, id) => {
      cancelCalls.push(id);
    },
  };
}

test('dryRun=true(預設)：只回報，不會真的呼叫 cancelBooking', async () => {
  const cancelCalls = [];
  const dbBookings = [dbBooking('b1', 'm-hongwen', '2026-07-05', '09:00', '陳先生')];
  const result = await reconcileMonth({}, { year: 2026, month: 7 }, deps({ sheetRecords: [], dbBookings, cancelCalls }));

  assert.equal(result.dryRun, true);
  assert.equal(cancelCalls.length, 0, 'dry run 不該真的執行取消');
  assert.equal(result.toCancelCount, 1);
  assert.equal(result.toCancel[0].customerName, '陳先生');
});

test('dryRun=false：真的對每一筆該取消的呼叫 cancelBooking', async () => {
  const cancelCalls = [];
  const dbBookings = [
    dbBooking('b1', 'm-hongwen', '2026-07-05', '09:00', '陳先生'),
    dbBooking('b2', 'm-qi', '2026-07-06', '10:00', '林小姐'),
  ];
  const result = await reconcileMonth({}, { year: 2026, month: 7, dryRun: false }, deps({ sheetRecords: [], dbBookings, cancelCalls }));

  assert.equal(cancelCalls.length, 2);
  assert.ok(cancelCalls.includes('b1'));
  assert.ok(cancelCalls.includes('b2'));
  assert.equal(result.toCancelCount, 2);
});

test('DB 那筆在 Sheet 上找得到對應(同師傅/日期/時間) -> 保留，不列入 toCancel', async () => {
  const cancelCalls = [];
  const sheetRecords = [sheetRecord('泓文', '2026-07-05', '09:00')];
  const dbBookings = [dbBooking('b1', 'm-hongwen', '2026-07-05', '09:00', '陳先生')];
  const result = await reconcileMonth({}, { year: 2026, month: 7 }, deps({ sheetRecords, dbBookings, cancelCalls }));

  assert.equal(result.toCancelCount, 0);
  assert.equal(result.keptCount, 1);
});

test('日期或時間對不上(即使同師傅)：算「找不到對應」，要列入 toCancel', async () => {
  const sheetRecords = [sheetRecord('泓文', '2026-07-05', '09:00')];
  const dbBookings = [dbBooking('b1', 'm-hongwen', '2026-07-05', '09:30', '陳先生')]; // 時間差半小時
  const result = await reconcileMonth({}, { year: 2026, month: 7 }, deps({ sheetRecords, dbBookings }));

  assert.equal(result.toCancelCount, 1);
});

test('master_id 對不到任何在職師傅(可能已停用)：仍然列入 toCancel，且標記清楚原因', async () => {
  const dbBookings = [dbBooking('b1', 'm-not-exist', '2026-07-05', '09:00', '陳先生')];
  const result = await reconcileMonth({}, { year: 2026, month: 7 }, deps({ dbBookings }));

  assert.equal(result.toCancelCount, 1);
  assert.match(result.toCancel[0].masterName, /對不到有效師傅/);
});

test('回傳的統計數字要正確(sheetRecordCount/dbBookingCount/keptCount/toCancelCount)', async () => {
  const sheetRecords = [sheetRecord('泓文', '2026-07-05', '09:00'), sheetRecord('麒', '2026-07-06', '10:00')];
  const dbBookings = [
    dbBooking('b1', 'm-hongwen', '2026-07-05', '09:00', '陳先生'), // 對得上，保留
    dbBooking('b2', 'm-qi', '2026-07-07', '11:00', '林小姐'), // 對不上，取消
  ];
  const result = await reconcileMonth({}, { year: 2026, month: 7 }, deps({ sheetRecords, dbBookings }));

  assert.equal(result.sheetRecordCount, 2);
  assert.equal(result.dbBookingCount, 2);
  assert.equal(result.keptCount, 1);
  assert.equal(result.toCancelCount, 1);
});

test('toCancel 清單裡每一筆都帶完整資訊(師傅名字/日期/時間/客戶名/來源)，方便人工審核', async () => {
  const dbBookings = [dbBooking('b1', 'm-hongwen', '2026-07-05', '09:00', '陳先生', 'customer_app')];
  const result = await reconcileMonth({}, { year: 2026, month: 7 }, deps({ dbBookings }));

  const entry = result.toCancel[0];
  assert.equal(entry.id, 'b1');
  assert.equal(entry.masterName, '泓文');
  assert.equal(entry.date, '2026-07-05');
  assert.equal(entry.customerName, '陳先生');
  assert.equal(entry.bookingSource, 'customer_app');
});

test('沒有任何 DB 預約需要取消時，toCancel 是空陣列，不是 undefined 或丟錯', async () => {
  const sheetRecords = [sheetRecord('泓文', '2026-07-05', '09:00')];
  const dbBookings = [dbBooking('b1', 'm-hongwen', '2026-07-05', '09:00', '陳先生')];
  const result = await reconcileMonth({}, { year: 2026, month: 7 }, deps({ sheetRecords, dbBookings }));

  assert.deepEqual(result.toCancel, []);
  assert.equal(result.toCancelCount, 0);
});
