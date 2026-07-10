import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBookingRecord } from '../src/validate.js';

const MASTERS = [
  { id: 'uuid-xu', name: '許老師' },
  { id: 'uuid-wei', name: '魏老師' },
];

function baseRecord(overrides = {}) {
  return {
    identityKey: '許老師|2026-07-13|09:00',
    contentHash: 'h1',
    date: '2026-07-13',
    startTime: '09:00',
    masterName: '許老師',
    customerName: '王小明',
    ...overrides,
  };
}

function deps({ masters = MASTERS, existingBooking = null } = {}) {
  return {
    fetchActiveMasters: async () => masters,
    findBookingAtSlot: async () => existingBooking,
  };
}

test('全部合法、沒有衝突 → valid，row 欄位對應正確', async () => {
  const result = await validateBookingRecord(baseRecord(), {}, deps());
  assert.equal(result.valid, true);
  assert.equal(result.row.master_id, 'uuid-xu');
  assert.equal(result.row.start_time, '09:00:00');
  assert.equal(result.row.customer_name, '王小明');
  assert.equal(result.row.status, 'confirmed');
  assert.equal(result.row.booking_source, 'sheet_sync');
});

test('日期空白', async () => {
  const result = await validateBookingRecord(baseRecord({ date: '' }), {}, deps());
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('日期不能空白'));
});

test('日期格式錯誤(例如用斜線)', async () => {
  const result = await validateBookingRecord(baseRecord({ date: '2026/07/13' }), {}, deps());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('日期格式錯誤')));
});

test('時間格式錯誤', async () => {
  const result = await validateBookingRecord(baseRecord({ startTime: '9點' }), {}, deps());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('時間格式錯誤')));
});

test('師傅姓名對不到任何在職師傅', async () => {
  const result = await validateBookingRecord(baseRecord({ masterName: '不存在的師傅' }), {}, deps());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('找不到師傅')));
});

test('姓名空白', async () => {
  const result = await validateBookingRecord(baseRecord({ customerName: '' }), {}, deps());
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('姓名不能空白'));
});

test('人數是負數', async () => {
  const result = await validateBookingRecord(baseRecord({ guestCount: -1 }), {}, deps());
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('人數格式錯誤'));
});

test('人數不是整數', async () => {
  const result = await validateBookingRecord(baseRecord({ guestCount: 1.5 }), {}, deps());
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('人數格式錯誤'));
});

test('同一格已有既有預約、但顧客姓名一樣 → 視為更新自己，不算衝突', async () => {
  const result = await validateBookingRecord(
    baseRecord({ customerName: '王小明' }),
    {},
    deps({ existingBooking: { id: 'b1', customer_name: '王小明' } })
  );
  assert.equal(result.valid, true);
});

test('同一格已有既有預約、顧客姓名不一樣 → 真衝突，擋下來', async () => {
  const result = await validateBookingRecord(
    baseRecord({ customerName: '王小明' }),
    {},
    deps({ existingBooking: { id: 'b1', customer_name: '陳小華' } })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('衝突')));
  assert.ok(result.errors.some((e) => e.includes('陳小華')));
});

test('格式錯誤時不該多花一次查詢去檢查衝突(效率+避免拿無效資料去查)', async () => {
  let conflictCheckCalled = false;
  const result = await validateBookingRecord(baseRecord({ date: 'bad-date' }), {}, {
    fetchActiveMasters: async () => MASTERS,
    findBookingAtSlot: async () => {
      conflictCheckCalled = true;
      return null;
    },
  });
  assert.equal(result.valid, false);
  assert.equal(conflictCheckCalled, false);
});

test('多個錯誤同時發生時，全部要收集起來，不是只回傳第一個', async () => {
  const result = await validateBookingRecord(
    baseRecord({ date: '', startTime: '', masterName: '', customerName: '' }),
    {},
    deps()
  );
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 4);
});
