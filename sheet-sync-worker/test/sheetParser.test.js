import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetRows, cell } from './sheetParserFixtures.js';
import { dateStringToSerial } from '../src/sheetsSerial.js';
import {
  parseGridIntoRecords,
  findBlockHeaderRows,
  buildWeekdayColumnMap,
  monthsSpannedByWeek,
  fetchAndParseWeek,
  SHEET_MASTERS,
} from '../src/sheetParser.js';

const MONDAY = dateStringToSerial('2026-07-06');
const FULL_WEEK_SERIALS = [MONDAY - 1, MONDAY, MONDAY + 1, MONDAY + 2, MONDAY + 3, MONDAY + 4, MONDAY + 5];
// 週日..週六 對應 2026-07-05 ~ 2026-07-11

test('findBlockHeaderRows: 找到所有「時間」表頭列', () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: {} }, { dateSerials: FULL_WEEK_SERIALS, slots: {} }]);
  assert.deepEqual(findBlockHeaderRows(rows), [1, 35]);
});

test('buildWeekdayColumnMap: 第 1 列沒有週日～週六表頭要丟錯', () => {
  assert.throws(() => buildWeekdayColumnMap([[cell('不是表頭')]]), /週日～週六/);
});

test('單一時段的一般預約：正確解析出姓名/日期/時間', async () => {
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[3, '王小明', null]] } }, // col 3 = 週三 = 2026-07-08, slot 0 = 8:00
  ]);
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, '王小明');
  assert.equal(records[0].date, '2026-07-08');
  assert.equal(records[0].startTime, '08:00');
  assert.equal(records[0].masterName, '麒');
  assert.equal(records[0].slotCount, 1);
  assert.equal(records[0].needsReview, false);
});

test('已知延續符號(麒的彎引號)：連續三格合併成一筆，slotCount=3', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[3, '王小明', null]],
        1: [[3, '\u201D', null]],
        2: [[3, '\u201D', null]],
      },
    },
  ]);
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, '王小明');
  assert.equal(records[0].startTime, '08:00');
  assert.equal(records[0].slotCount, 3);
});

test('已知延續符號(泓文的雙直引號)：也要正確合併', async () => {
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '陳小華', null]], 1: [[2, "''", null]] } },
  ]);
  const master = { name: '泓文', continuationMarks: ["''"] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].slotCount, 2);
});

test('未知符號(不在任何清單裡)：不合併，且被標記 needsReview，避免靜默誤判', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '\u3003', null]] } }]);
  const master = { name: '假設師傅', continuationMarks: [], anonymousReturningCustomerMarks: [] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, '\u3003');
  assert.equal(records[0].needsReview, true);
});

test('治的「*」= 已確認的「舊客不打名字」標記：customerName 填「舊客」，不合併、不標記 needsReview', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '*', null]] } }]);
  const master = { name: '治', continuationMarks: [], anonymousReturningCustomerMarks: ['*'] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, '舊客');
  assert.equal(records[0].needsReview, false);
  assert.equal(records[0].slotCount, 1);
});

test('紅底(#FF0000) → colorTag="vacation"(休假/不開放)，原本文字保留當備註不覆蓋', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '政漢', '#FF0000']] } }]);
  const master = { name: '麒', continuationMarks: ['\u201D'], anonymousReturningCustomerMarks: [] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records[0].colorTag, 'vacation');
  assert.equal(records[0].customerName, '政漢');
  assert.equal(records[0].isNewCustomer, false);
});

test('空格子會結束前一筆累積中的預約，不會被下一筆新內容誤合併進去', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[3, '王小明', null]],
        1: [[3, '\u201D', null]],
        // slot 2 空白
        3: [[3, '陳小華', null]], // 新的一筆，不該被合併進王小明那筆
      },
    },
  ]);
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 2);
  assert.equal(records[0].customerName, '王小明');
  assert.equal(records[0].slotCount, 2);
  assert.equal(records[1].customerName, '陳小華');
  assert.equal(records[1].slotCount, 1);
});

test('黃底(#FFFF00) → isNewCustomer=true；其他顏色(或沒顏色) → false', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[1, '新客戶', '#FFFF00']],
        1: [[2, '舊客戶', null]],
        2: [[3, '別的顏色', '#FF9900']],
      },
    },
  ]);
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  const records = await parseGridIntoRecords(rows, master);
  const byName = Object.fromEntries(records.map((r) => [r.customerName, r]));
  assert.equal(byName['新客戶'].isNewCustomer, true);
  assert.equal(byName['舊客戶'].isNewCustomer, false);
  assert.equal(byName['別的顏色'].isNewCustomer, false);
});

test('像壞掉公式參照的內容(#REF!)要標記 needsReview，原因要說明是公式參照', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '#REF!', null]] } }]);
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records[0].needsReview, true);
  assert.ok(records[0].reviewReasons.some((r) => r.includes('公式參照')));
});

test('這欄在這個區塊沒有日期(表頭是 null)：就算有內容也要整個跳過，不產生記錄', async () => {
  const noSunday = [null, ...FULL_WEEK_SERIALS.slice(1)];
  const rows = buildSheetRows([{ dateSerials: noSunday, slots: { 0: [[0, '不該出現的內容', null]] } }]);
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 0);
});

test('一個分頁裡有多個週區塊，每個都要解析到', async () => {
  const nextWeek = FULL_WEEK_SERIALS.map((s) => s + 7);
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '第一週的客人', null]] } },
    { dateSerials: nextWeek, slots: { 0: [[1, '第二週的客人', null]] } },
  ]);
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.customerName).sort(),
    ['第一週的客人', '第二週的客人']
  );
});

test('週區塊結構跟預期不符(人數列位置不對)要丟出清楚的錯誤，不要往下硬解析', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: {} }]);
  rows[1 + 31][0] = cell('不是人數'); // 破壞掉預期的「人數」小計列
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  await assert.rejects(() => parseGridIntoRecords(rows, master), /人數/);
});

test('相同內容 → 相同 contentHash；姓名不同 → 不同 contentHash(給 diff.js 判斷用)', async () => {
  const rows1 = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '王小明', null]] } }]);
  const rows2 = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '王小明', null]] } }]);
  const rows3 = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '陳小華', null]] } }]);
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  const [r1] = await parseGridIntoRecords(rows1, master);
  const [r2] = await parseGridIntoRecords(rows2, master);
  const [r3] = await parseGridIntoRecords(rows3, master);
  assert.equal(r1.contentHash, r2.contentHash);
  assert.notEqual(r1.contentHash, r3.contentHash);
});

test('monthsSpannedByWeek: 完全在同一個月內的週 → 只回傳 1 個月分', () => {
  assert.deepEqual(monthsSpannedByWeek('2026-07-06'), [{ year: 2026, month: 7 }]);
});

test('monthsSpannedByWeek: 跨月的週(例如 6/29 週一到 7/5 週日) → 回傳 2 個月分，順序由舊到新', () => {
  assert.deepEqual(monthsSpannedByWeek('2026-06-29'), [
    { year: 2026, month: 6 },
    { year: 2026, month: 7 },
  ]);
});

test('monthsSpannedByWeek: 跨年份的週(12月底到1月初)也要正確', () => {
  assert.deepEqual(monthsSpannedByWeek('2026-12-28'), [
    { year: 2026, month: 12 },
    { year: 2027, month: 1 },
  ]);
});

test('fetchAndParseWeek: 依照 SHEET_MASTERS 清單逐一查詢分頁，結果合併起來、只留目標週範圍內的', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '測試客人', null]] } }]);
  const calledSheetTitles = [];

  const records = await fetchAndParseWeek(
    {},
    '2026-07-06',
    {
      getAccessToken: async () => 'fake-token',
      fetchGridRows: async (env, { sheetTitle }) => {
        calledSheetTitles.push(sheetTitle);
        return { title: sheetTitle, rows };
      },
    }
  );

  // 4 位師傅 x 1 個月分 = 4 次查詢
  assert.deepEqual(calledSheetTitles.sort(), ['7月-哲瑋', '7月-治', '7月-泓文', '7月-麒'].sort());
  assert.equal(records.length, SHEET_MASTERS.length); // 每個分頁都解析出同一筆假資料
});

test('fetchAndParseWeek: 某個師傅/月分讀取失敗要丟出清楚指出是哪個分頁的錯誤', async () => {
  await assert.rejects(
    () =>
      fetchAndParseWeek(
        {},
        '2026-07-06',
        {
          getAccessToken: async () => 'fake-token',
          fetchGridRows: async () => {
            throw new Error('模擬 API 錯誤');
          },
        }
      ),
    /讀取分頁「7月-/
  );
});

test('麒(sheet暱稱) → masterName 要填正式名字「許老師」，sheetMasterLabel 保留「麒」給寫回用', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '王小明', null]] } }]);
  const master = SHEET_MASTERS.find((m) => m.name === '麒');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records[0].masterName, '許老師');
  assert.equal(records[0].sheetMasterLabel, '麒');
});

test('治(sheet暱稱) → masterName 要填正式名字「魏老師」', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '王小明', null]] } }]);
  const master = SHEET_MASTERS.find((m) => m.name === '治');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records[0].masterName, '魏老師');
  assert.equal(records[0].sheetMasterLabel, '治');
});

test('泓文/哲瑋沒有另外設定 masterDbName：masterName 直接等於 sheet 暱稱本身', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '王小明', null]] } }]);
  const hongwen = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, hongwen);
  assert.equal(records[0].masterName, '泓文');
  assert.equal(records[0].sheetMasterLabel, '泓文');
});

test('identityKey 是用正式名字(masterName)組的，不是 sheet 暱稱', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '王小明', null]] } }]);
  const master = SHEET_MASTERS.find((m) => m.name === '麒');
  const records = await parseGridIntoRecords(rows, master);
  assert.ok(records[0].identityKey.startsWith('許老師|'));
});

test('哲瑋的延續符號跟泓文一樣是兩個直引號(已確認)：會自動合併', async () => {
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '陳小華', null]], 1: [[2, "''", null]] } },
  ]);
  const master = SHEET_MASTERS.find((m) => m.name === '哲瑋');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, '陳小華');
  assert.equal(records[0].slotCount, 2);
  assert.equal(records[0].needsReview, false);
});
