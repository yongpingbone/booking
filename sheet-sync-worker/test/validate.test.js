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
  assert.equal(result.row.booking_source, 'internal');
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

test('同一格已有既有預約、顧客姓名不一樣 → 以 Sheet 為準覆蓋，不擋下來(Hanna 明確要求的規則)', async () => {
  const result = await validateBookingRecord(
    baseRecord({ customerName: '王小明' }),
    {},
    deps({ existingBooking: { id: 'b1', customer_name: '陳小華' } })
  );
  assert.equal(result.valid, true);
  assert.equal(result.existingId, 'b1', '要帶出既有那筆的 id 才能覆蓋(PATCH)，不是當成新的一筆');
  assert.equal(result.row.customer_name, '王小明', 'Sheet 上的內容為準');
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

test('existingId：同 slot 沒有既有預約時是 null(代表要新增)', async () => {
  const result = await validateBookingRecord(baseRecord(), {}, deps({ existingBooking: null }));
  assert.equal(result.valid, true);
  assert.equal(result.existingId, null);
});

test('existingId：同 slot 有既有預約且姓名相符時，帶出那筆的 id(代表要更新)', async () => {
  const result = await validateBookingRecord(
    baseRecord({ customerName: '王小明' }),
    {},
    deps({ existingBooking: { id: 'existing-abc', customer_name: '王小明' } })
  );
  assert.equal(result.valid, true);
  assert.equal(result.existingId, 'existing-abc');
});

test('needsReview:true 的記錄要被擋下來，不能寫進資料庫(之前這個標記從沒被真的檢查過，#REF! 這種壞資料因此流進去過)', async () => {
  const result = await validateBookingRecord(
    baseRecord({ customerName: '#REF!', needsReview: true, reviewReasons: ['內容是壞掉的公式參照(#REF!)，可能是原本參照的列/儲存格被刪除，需要人工確認'] }),
    {},
    deps()
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('#REF!')));
});

test('needsReview:true 但沒有帶 reviewReasons 時，還是要擋下來、給一個通用錯誤訊息，不是靜默放行', async () => {
  const result = await validateBookingRecord(baseRecord({ needsReview: true }), {}, deps());
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('needsReview:false(或沒設定)的正常記錄不受影響，照常通過驗證', async () => {
  const result = await validateBookingRecord(baseRecord({ needsReview: false }), {}, deps());
  assert.equal(result.valid, true);
});
