// validate.js
//
// 這支邏輯是直接從 yongpingbone/booking repo 的 index.html 裡
// handleImportFile()(CSV 匯入的驗證那段)搬過來對齊的，不是重新猜一套規則。
// 原始碼位置：booking repo / index.html，關鍵字 "CSV 匯入：解析＋逐列驗證"。
//
// 對齊的規則：
//   1. 日期格式 /^\d{4}-\d{2}-\d{2}$/
//   2. 時間格式 /^\d{1,2}:\d{2}$/
//   3. 師傅姓名 → 用 masters 表(is_active=true) 的 name 對回 id，對不到就是錯誤
//   4. 姓名不能空白
//   5. 排班衝突：同一個師傅、同一天、同一個時間，且對方不是 cancelled/no_show
//
// 跟原本 CSV 匯入不完全一樣的地方(刻意調整，原因見下)：
//   - CSV 匯入用 `o.id !== p.id` 排除「正在更新的那筆自己」，直接對 Postgres
//     做原生 upsert(ON CONFLICT)。Sheet 同步這邊查出的 bookings 表 unique
//     index(idx_unique_master_datetime)是 partial index(排除 cancelled/
//     no_show)，PostgREST 的 on_conflict= 沒辦法正確對到 partial index，
//     所以改成：先用 findBookingAtSlot 查有沒有同 slot 的既有預約，有的話
//     把它的 id 帶出去給 supabaseClient.saveBooking() 做 PATCH；沒有的話
//     existingId 是 null，做 POST 新增。
//   - 同 slot 既有預約內容(尤其 customer_name)跟 Sheet 上這筆不一樣時，
//     一律【以 Sheet 為準】直接覆蓋，不擋下來——這是 Hanna 明確、重複強調
//     過的規則(app 目前測試階段，Sheet 才是真正在使用、最準確的資料來源)。
//     之前這裡有一版「名字不一樣就當真衝突、擋下來不寫」的邏輯，已經移除。

import { fetchActiveMasters, findBookingAtSlot } from './supabaseClient.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

/**
 * @param {import('./diff.js').BookingRecord & {
 *   date: string, startTime: string, masterName: string,
 *   customerName: string, customerPhone?: string, guestCount?: number,
 *   colorTag?: string, note?: string
 * }} record
 * @param {object} env
 * @param {object} [deps] 測試用依賴注入
 * @returns {Promise<{valid: true, row: object} | {valid: false, errors: string[]}>}
 */
async function validateBookingRecord(record, env, deps = {}) {
  const { fetchActiveMasters: doFetchMasters = fetchActiveMasters, findBookingAtSlot: doFindBookingAtSlot = findBookingAtSlot } = deps;

  const errors = [];

  if (!record.date) errors.push('日期不能空白');
  else if (!DATE_RE.test(record.date)) errors.push('日期格式錯誤（要 YYYY-MM-DD）');

  if (!record.startTime) errors.push('時間不能空白');
  else if (!TIME_RE.test(record.startTime)) errors.push('時間格式錯誤（要 HH:MM）');

  if (!record.masterName) errors.push('師傅不能空白');
  if (!record.customerName) errors.push('姓名不能空白');

  let masterId = null;
  if (record.masterName) {
    const masters = await doFetchMasters(env);
    const masterByName = Object.fromEntries(masters.map((m) => [m.name, m.id]));
    masterId = masterByName[record.masterName] ?? null;
    if (!masterId) errors.push(`找不到師傅「${record.masterName}」`);
  }

  if (record.guestCount !== undefined && record.guestCount !== null) {
    const n = Number(record.guestCount);
    if (!Number.isInteger(n) || n < 0) errors.push('人數格式錯誤');
  }

  // 格式/對照都過了才值得花一次查詢去查同 slot 有沒有既有預約。查到就直接
  // 拿它的 id 去覆蓋(以 Sheet 為準)，不比對內容是否相同、不當成衝突擋下來。
  let existing = null;
  if (!errors.length) {
    existing = await doFindBookingAtSlot(env, { masterId, date: record.date, startTime: record.startTime });
  }

  if (errors.length) return { valid: false, errors };

  return {
    valid: true,
    existingId: existing?.id ?? null, // 有值 → 覆蓋這筆既有資料；null → 新增一筆
    row: {
      date: record.date,
      start_time: `${record.startTime}:00`,
      master_id: masterId,
      customer_name: record.customerName,
      customer_phone: record.customerPhone || null,
      guest_count: record.guestCount ?? 1,
      color_tag: record.colorTag ?? 'none',
      note: record.note || null,
      status: 'confirmed',
      // 另一個 session 同時在改這個 repo 時新增了 is_aftercare 欄位(售後從
      // color_tag 的一個值改成獨立勾選)。Sheet 同步進來的預約不會是售後，
      // 明確填 false，不要留給資料庫的預設值去猜(如果它剛好是 NOT NULL
      // 沒有預設值，沒填會直接寫入失敗)。
      is_aftercare: false,
      // bookings_booking_source_check 只允許 'internal'/'online'/'customer_app'/
      // 'historical_import'(已跟 Hanna 用 SQL 查證過)，沒有 'sheet_sync' 這個值。
      // 用 'internal'：Sheet 本來就是師傅自己管理排班的地方，語意上跟直接在
      // 系統裡建預約是同一件事。如果之後想要能單獨篩出「這筆是從 Sheet 同步
      // 進來的」，需要先對 bookings_booking_source_check 做 ALTER 加值，
      // 這支才能跟著改，目前沒有那個欄位可用。
      booking_source: 'internal',
      reservation_type: 'single',
      party_size: 1,
    },
  };
}

export { validateBookingRecord };
