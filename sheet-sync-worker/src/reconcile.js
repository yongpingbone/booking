// reconcile.js
//
// 一次性的月份校正功能：以 Sheet 為準，把 APP 資料庫裡「Sheet 上找不到對應」
// 的預約標記成取消(不是刪除，資料還在，可以回頭查)。
//
// 不是排程的一部分，是獨立、手動觸發的操作——見 index.js 的 /reconcile-month
// 路由。安全機制：預設 dryRun=true，只回報「會影響哪些」，不會真的動手；
// 要 dryRun=false 才會真的執行取消，而且要先看過 dry run 的結果再決定。

import { fetchAndParseMonth } from './sheetParser.js';
import { fetchActiveMasters, fetchBookingsInMonth, cancelBooking } from './supabaseClient.js';

/**
 * @param {object} env
 * @param {{year: number, month: number, dryRun?: boolean}} params month 1-12，dryRun 預設 true
 * @param {object} [deps] 測試用依賴注入
 * @returns {Promise<object>}
 */
async function reconcileMonth(env, { year, month, dryRun = true }, deps = {}) {
  const doFetchAndParseMonth = deps.fetchAndParseMonth ?? fetchAndParseMonth;
  const doFetchActiveMasters = deps.fetchActiveMasters ?? fetchActiveMasters;
  const doFetchBookingsInMonth = deps.fetchBookingsInMonth ?? fetchBookingsInMonth;
  const doCancelBooking = deps.cancelBooking ?? cancelBooking;

  const [sheetRecords, masters, dbBookings] = await Promise.all([
    doFetchAndParseMonth(env, year, month),
    doFetchActiveMasters(env),
    doFetchBookingsInMonth(env, { year, month }),
  ]);

  const masterIdToName = new Map(masters.map((m) => [m.id, m.name]));
  const sheetKeys = new Set(sheetRecords.map((r) => `${r.masterName}|${r.date}|${r.startTime}`));

  const kept = [];
  const toCancel = [];

  for (const booking of dbBookings) {
    const masterName = masterIdToName.get(booking.master_id);
    const startTimeHHMM = (booking.start_time ?? '').slice(0, 5); // "09:00:00" -> "09:00"
    const key = `${masterName}|${booking.date}|${startTimeHHMM}`;
    if (masterName && sheetKeys.has(key)) {
      kept.push(booking);
    } else {
      toCancel.push({ ...booking, masterName: masterName ?? null });
    }
  }

  if (!dryRun) {
    for (const booking of toCancel) {
      await doCancelBooking(env, booking.id);
    }
  }

  return {
    year,
    month,
    dryRun,
    sheetRecordCount: sheetRecords.length,
    dbBookingCount: dbBookings.length,
    keptCount: kept.length,
    toCancelCount: toCancel.length,
    toCancel: toCancel.map((b) => ({
      id: b.id,
      masterName: b.masterName ?? '(對不到有效師傅，master_id 可能已經停用)',
      date: b.date,
      startTime: b.start_time,
      customerName: b.customer_name,
      bookingSource: b.booking_source,
    })),
  };
}

export { reconcileMonth };
