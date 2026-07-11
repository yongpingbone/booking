// sheetWriter.js
//
// 把驗證失敗/排班衝突的結果寫回 Sheet，用「儲存格備註(note)」而不是改內容
// 或改顏色——這樣師傅打開 Sheet 看到小紅角提示就知道哪裡有問題，同時完全
// 不影響 diff.js 用的 contentHash(hashContent 沒有把 note 算進去)，寫回動作
// 不會被下一輪同步誤判成師傅的新異動，天生就不需要額外的防迴圈標記機制。
//
// ⚠️ 這支需要服務帳號對 Sheet 有「編輯者」權限，不能只是檢視——見
// googleAuth.js 開頭註解。也需要真的打 sheets.googleapis.com，我的
// sandbox 連不到，部署後第一次跑務必看 log 確認有成功寫入。

import { getAccessToken as defaultGetAccessToken } from './googleAuth.js';
import { setCellNote as defaultSetCellNote } from './sheetsApi.js';
import { SLOTS_PER_BLOCK, BLOCK_ROW_SPAN } from './sheetParser.js';

/**
 * 給一筆預約的(date, startTime, sheetMasterLabel)，反推它在 Sheet 上實際的
 * (分頁, 列, 欄)位置。純函式、不打 API，邏輯是 parseGridIntoRecords 座標
 * 系統的反向版本，兩邊共用同一組常數(SLOTS_PER_BLOCK / BLOCK_ROW_SPAN)，
 * 座標系統改了兩邊會一起改，不會兜不起來。
 *
 * ⚠️ 這裡要用 sheetMasterLabel(分頁暱稱，例如「麒」)組分頁名稱，不能用
 * masterName(正式名字，例如「許老師」)——Sheet 分頁叫「7月-麒」，不叫
 * 「7月-許老師」。
 * @param {{date: string, startTime: string, sheetMasterLabel: string}} record
 * @returns {{sheetTitle: string, rowIndex: number, colIndex: number}} rowIndex/colIndex 都是 0-indexed
 */
function resolveCellReference({ date, startTime, sheetMasterLabel }) {
  const [year, month] = date.split('-').map(Number);
  const sheetTitle = `${month}月-${sheetMasterLabel}`;

  // 全部日期運算都固定用 T12:00:00Z 當基準(而不是午夜)，避免整數天數差在
  // 剛好卡在 .5 天的邊界時，四捨五入方向不穩定、算錯區塊編號。
  const firstOfMonth = new Date(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01T12:00:00Z`);
  const firstWeekday = firstOfMonth.getUTCDay(); // 0=週日..6=週六
  const block0Sunday = new Date(firstOfMonth);
  block0Sunday.setUTCDate(block0Sunday.getUTCDate() - firstWeekday);

  const targetDate = new Date(`${date}T12:00:00Z`);
  const daysSinceBlock0Sunday = Math.round((targetDate - block0Sunday) / (24 * 60 * 60 * 1000));
  const blockIndex = Math.floor(daysSinceBlock0Sunday / 7);
  const weekday = targetDate.getUTCDay();

  const [hourStr, minStr] = startTime.split(':');
  const hour = Number(hourStr);
  const minute = Number(minStr);
  if (minute !== 0 && minute !== 30) {
    throw new Error(`時間 "${startTime}" 不是整點或半點，Sheet 只有 :00 / :30 兩種時段，沒辦法反推儲存格位置`);
  }
  const slotIndex = (hour - 8) * 2 + (minute === 30 ? 1 : 0);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= SLOTS_PER_BLOCK) {
    throw new Error(`時間 "${startTime}" 超出 Sheet 涵蓋的時段範圍(8:00~22:30)，沒辦法反推儲存格位置`);
  }

  const headerRowIndex = 1 + BLOCK_ROW_SPAN * blockIndex; // 0-indexed："時間"那列
  const rowIndex = headerRowIndex + 1 + slotIndex;
  const colIndex = 1 + weekday; // 0-indexed：B欄(index1)=週日

  return { sheetTitle, rowIndex, colIndex };
}

/**
 * @param {object} env
 * @param {{date: string, startTime: string, sheetMasterLabel: string}} record
 * @param {{type: 'invalid'|'synced', message?: string}} status
 * @param {object} [deps] 測試用依賴注入：{ getAccessToken, setCellNote }
 * @returns {Promise<void>}
 */
async function markCellStatus(env, record, status, deps = {}) {
  const doGetAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  const doSetCellNote = deps.setCellNote ?? defaultSetCellNote;

  const { sheetTitle, rowIndex, colIndex } = resolveCellReference(record);
  const accessToken = await doGetAccessToken(env);

  // synced 時清空備註(null)，不是寫「已同步」這種文字——理由：
  //   1. 自動清掉這格之前可能留著的舊錯誤備註(Hanna 要求)，不會讓過期的
  //      錯誤訊息一直卡在 Sheet 上，即使問題早就解決了。
  //   2. 不會每次同步成功都多一則提示，Sheet 上不會被一堆「已同步」訊息
  //      洗版——沒事發生時就保持安靜，只有真的需要師傅注意時(驗證失敗)
  //      才顯示訊息，這樣的提示才有意義。
  if (status.type === 'synced') {
    await doSetCellNote(env, { sheetTitle, rowIndex, colIndex, note: null, accessToken });
    return;
  }

  const prefix = { invalid: '⚠️ 同步失敗' }[status.type] ?? '⚠️';
  const note = status.message ? `${prefix}：${status.message}` : prefix;

  await doSetCellNote(env, { sheetTitle, rowIndex, colIndex, note, accessToken });
}

export { resolveCellReference, markCellStatus };
