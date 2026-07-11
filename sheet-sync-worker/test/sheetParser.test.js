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
  fetchAndParseMonth,
  ensureMonthCached,
  fetchAndParseWeekCached,
  SHEET_MASTERS,
  resolveColorTag,
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

test('已知延續符號(麒的彎引號)：連續三格產生三筆獨立記錄，同行者依序編號(超過2人才編號)', async () => {
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
  assert.equal(records.length, 3, '本人 + 2位同行者，各自獨立一筆，不合併');
  assert.equal(records[0].customerName, '王小明');
  assert.equal(records[0].startTime, '08:00');
  assert.equal(records[0].slotCount, 1, '本人自己的 slotCount 不該被同行者影響');
  assert.equal(records[1].customerName, '王小明-同行1');
  assert.equal(records[1].startTime, '08:30');
  assert.equal(records[2].customerName, '王小明-同行2');
  assert.equal(records[2].startTime, '09:00');
});

test('已知延續符號(泓文的雙直引號)：只有1位同行者時不編號(單純「-同行」)', async () => {
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '陳小華', null]], 1: [[2, "''", null]] } },
  ]);
  const master = { name: '泓文', continuationMarks: ["''"] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 2);
  assert.equal(records[0].customerName, '陳小華');
  assert.equal(records[1].customerName, '陳小華-同行');
});

test('未知符號(不在任何清單裡)：不合併，且被標記 needsReview，避免靜默誤判', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '\u3003', null]] } }]);
  const master = { name: '假設師傅', continuationMarks: [], anonymousReturningCustomerMarks: [] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, '\u3003');
  assert.equal(records[0].needsReview, true);
});

test('治的「*」= 已確認的「舊客不打名字」標記：customerName 保留原始的「*」(不翻譯，要跟資料庫既有紀錄一致)，不合併、不標記 needsReview', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '*', null]] } }]);
  const master = { name: '治', continuationMarks: [], anonymousReturningCustomerMarks: ['*'] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, '*');
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

test('空格子會結束前一筆累積中的預約，不會被下一筆新內容誤合併進去(同行者計數也一起中斷)', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[3, '王小明', null]],
        1: [[3, '\u201D', null]],
        // slot 2 空白
        3: [[3, '陳小華', null]], // 新的一筆，不該被當成王小明的同行者
      },
    },
  ]);
  const master = { name: '麒', continuationMarks: ['\u201D'] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 3);
  assert.equal(records[0].customerName, '王小明');
  assert.equal(records[1].customerName, '王小明-同行');
  assert.equal(records[2].customerName, '陳小華');
  assert.equal(records[2].startTime, '09:30');
});

test('哲瑋的延續符號跟泓文一樣是兩個直引號(已確認)：本人跟同行者都不標記 needsReview', async () => {
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '陳小華', null]], 1: [[2, "''", null]] } },
  ]);
  const master = SHEET_MASTERS.find((m) => m.name === '哲瑋');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 2);
  assert.equal(records[0].customerName, '陳小華');
  assert.equal(records[0].needsReview, false);
  assert.equal(records[1].customerName, '陳小華-同行');
  assert.equal(records[1].needsReview, false);
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

test('fetchAndParseMonth: 依 SHEET_MASTERS 逐一查詢，且過濾掉跨月週區塊裡不屬於這個月的日期', async () => {
  const augBoundarySerials = [
    dateStringToSerial('2026-07-26'),
    dateStringToSerial('2026-07-27'),
    dateStringToSerial('2026-07-28'),
    dateStringToSerial('2026-07-29'),
    dateStringToSerial('2026-07-30'),
    dateStringToSerial('2026-07-31'),
    dateStringToSerial('2026-08-01'), // 週六，已經是8月
  ];
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '客人A', null]] } }, // 2026-07-06
    { dateSerials: augBoundarySerials, slots: { 0: [[0, '客人B', null], [6, '客人C', null]] } }, // 7/26 跟 8/1
  ]);

  const calledSheetTitles = [];
  const records = await fetchAndParseMonth({}, 2026, 7, {
    getAccessToken: async () => 'fake-token',
    fetchGridRows: async (env, { sheetTitle }) => {
      calledSheetTitles.push(sheetTitle);
      return { title: sheetTitle, rows };
    },
  });

  assert.deepEqual(calledSheetTitles.sort(), ['7月-哲瑋', '7月-治', '7月-泓文', '7月-麒'].sort());
  const names = records.map((r) => r.customerName);
  assert.ok(names.includes('客人A'));
  assert.ok(names.includes('客人B'));
  assert.ok(!names.includes('客人C'), '8/1 已經是8月，即使出現在7月分頁的週區塊裡也不該被算進7月結果');
});

test('fetchAndParseMonth: 只呼叫 4 次(4 位師傅)，不像 fetchAndParseWeek 會因為跨月而變成 8 次', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: {} }]);
  const calledSheetTitles = [];
  await fetchAndParseMonth({}, 2026, 7, {
    getAccessToken: async () => 'fake-token',
    fetchGridRows: async (env, { sheetTitle }) => {
      calledSheetTitles.push(sheetTitle);
      return { title: sheetTitle, rows };
    },
  });
  assert.equal(calledSheetTitles.length, 4);
});

test('四位師傅 masterName 都直接等於 sheet 暱稱本身(已用 SQL 查證 masters.name 沒有「許老師/魏老師」這種正式稱呼)', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '王小明', null]] } }]);
  for (const masterName of ['泓文', '哲瑋', '麒', '治']) {
    const master = SHEET_MASTERS.find((m) => m.name === masterName);
    const records = await parseGridIntoRecords(rows, master);
    assert.equal(records[0].masterName, masterName);
    assert.equal(records[0].sheetMasterLabel, masterName);
  }
});

test('泓文/哲瑋沒有另外設定 masterDbName：masterName 直接等於 sheet 暱稱本身', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '王小明', null]] } }]);
  const hongwen = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, hongwen);
  assert.equal(records[0].masterName, '泓文');
  assert.equal(records[0].sheetMasterLabel, '泓文');
});

test('identityKey 是用 masterName 組的', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '王小明', null]] } }]);
  const master = SHEET_MASTERS.find((m) => m.name === '麒');
  const records = await parseGridIntoRecords(rows, master);
  assert.ok(records[0].identityKey.startsWith('麒|'));
});

test('哲瑋(從 SHEET_MASTERS 正式清單抓)：延續符號用法跟局部測試一致，不標記 needsReview', async () => {
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[2, '陳小華', null]], 1: [[2, "''", null]] } },
  ]);
  const master = SHEET_MASTERS.find((m) => m.name === '哲瑋');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 2);
  assert.equal(records[0].customerName, '陳小華');
  assert.equal(records[0].needsReview, false);
  assert.equal(records[1].customerName, '陳小華-同行');
  assert.equal(records[1].needsReview, false);
});

// ===== resolveColorTag =====

test('resolveColorTag: 沒有顏色(null) -> none', () => {
  assert.equal(resolveColorTag(null), 'none');
});

test('resolveColorTag: 黃底 -> new_customer', () => {
  assert.equal(resolveColorTag('#FFFF00'), 'new_customer');
});

test('resolveColorTag: 紅底 -> vacation', () => {
  assert.equal(resolveColorTag('#FF0000'), 'vacation');
});

test('resolveColorTag: 米黃色(泓文/哲瑋分頁單純分隔用) -> none', () => {
  assert.equal(resolveColorTag('#FFF2CC'), 'none');
});

test('resolveColorTag: 白色 -> none', () => {
  assert.equal(resolveColorTag('#FFFFFF'), 'none');
});

test('resolveColorTag: 不是黃/紅/中性色的任何顏色 -> custom', () => {
  assert.equal(resolveColorTag('#4A86E8'), 'custom'); // 藍
  assert.equal(resolveColorTag('#00FFFF'), 'custom'); // 青
  assert.equal(resolveColorTag('#A29BFE'), 'custom'); // 隨便一個沒看過的顏色
});

// ===== 空白但有顏色的格子(整塊色塊) =====

test('空白格子 + 紅色(休假)：要產生一筆紀錄，customerName 填「休假」，不能因為沒打字就跳過', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '', '#FF0000']] } }]);
  const master = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, '休假');
  assert.equal(records[0].colorTag, 'vacation');
  assert.equal(records[0].slotCount, 1);
});

test('空白格子 + 沒看過的顏色(自訂)：customerName 填「自訂」', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '', '#4A86E8']] } }]);
  const master = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, '自訂');
  assert.equal(records[0].colorTag, 'custom');
});

test('空白格子 + 中性色(米黃/白)或完全沒顏色：維持原本行為，不產生紀錄', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: { 0: [[1, '', '#FFF2CC'], [2, '', '#FFFFFF'], [3, '', null]] },
    },
  ]);
  const master = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 0);
});

test('連續好幾格都是同一種空白色塊：每格各自獨立一筆，不合併(Hanna 看過畫面後要求改成這樣)', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[1, '', '#FF0000']],
        1: [[1, '', '#FF0000']],
        2: [[1, '', '#FF0000']],
      },
    },
  ]);
  const master = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 3, '三個連續同色空白格應該各自獨立一筆，不合併');
  records.forEach((r) => {
    assert.equal(r.slotCount, 1);
    assert.equal(r.customerName, '休假');
  });
  assert.deepEqual(
    records.map((r) => r.startTime),
    ['08:00', '08:30', '09:00']
  );
});

test('空白色塊中間被真的空格(無顏色)斷開：不能跨過去合併', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[1, '', '#FF0000']],
        // slot 1 完全空白，沒有顏色，中斷
        2: [[1, '', '#FF0000']],
      },
    },
  ]);
  const master = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 2, '中間斷開了，應該是兩筆各自 slotCount=1，不是合併成一筆');
  assert.equal(records[0].slotCount, 1);
  assert.equal(records[1].slotCount, 1);
});

test('空白色塊後面接顏色不同的空白色塊：不合併，各自成一筆', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[1, '', '#FF0000']], // 休假
        1: [[1, '', '#4A86E8']], // 自訂，顏色不同
      },
    },
  ]);
  const master = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 2);
  assert.equal(records[0].colorTag, 'vacation');
  assert.equal(records[1].colorTag, 'custom');
});

test('空白色塊後面接真人姓名：不會被誤判成延續，姓名要正確產生新的一筆', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[1, '', '#FF0000']], // 休假
        1: [[1, '王小明', null]], // 休假結束，換成真的預約
      },
    },
  ]);
  const master = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 2);
  assert.equal(records[0].customerName, '休假');
  assert.equal(records[0].slotCount, 1);
  assert.equal(records[1].customerName, '王小明');
  assert.equal(records[1].slotCount, 1);
});

test('有文字內容、底色是自訂色(不是黃/紅/中性)：colorTag 要正確標成 custom，不是 none', async () => {
  const rows = buildSheetRows([{ dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '陳先生', '#00FFFF']] } }]);
  const master = SHEET_MASTERS.find((m) => m.name === '泓文');
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records[0].colorTag, 'custom');
  assert.equal(records[0].customerName, '陳先生', '有真的名字時不能被顏色的預設名稱蓋掉');
});

test('4位同行者(本人+3同行)：全部要編號 1/2/3', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[1, '林先生', null]],
        1: [[1, "''", null]],
        2: [[1, "''", null]],
        3: [[1, "''", null]],
      },
    },
  ]);
  const master = { name: '泓文', continuationMarks: ["''"] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 4);
  assert.deepEqual(
    records.map((r) => r.customerName),
    ['林先生', '林先生-同行1', '林先生-同行2', '林先生-同行3']
  );
});

test('同行者的 identityKey 各自獨立(用自己的 startTime)，不會互相碰撞', async () => {
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '林先生', null]], 1: [[1, "''", null]] } },
  ]);
  const master = { name: '泓文', continuationMarks: ["''"] };
  const records = await parseGridIntoRecords(rows, master);
  const keys = records.map((r) => r.identityKey);
  assert.equal(new Set(keys).size, 2, '兩筆 identityKey 應該各自不同');
  assert.ok(keys[1].includes('08:30'), '同行者要用自己那格的時間，不是沿用本人的時間');
});

test('同行者的 colorTag 沿用本人的顏色(app 本來就是同一張表單、同一個 color)', async () => {
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '林先生', '#FFFF00']], 1: [[1, "''", null]] } },
  ]);
  const master = { name: '泓文', continuationMarks: ["''"] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records[0].colorTag, 'new_customer');
  assert.equal(records[1].colorTag, 'new_customer', '同行者要沿用本人的 colorTag，不是自己那格(通常沒上色)的顏色');
});

test('同行者本身不算 isNewCustomer(新客判斷是看本人，不是每個同行者各自判斷)', async () => {
  const rows = buildSheetRows([
    { dateSerials: FULL_WEEK_SERIALS, slots: { 0: [[1, '林先生', '#FFFF00']], 1: [[1, "''", null]] } },
  ]);
  const master = { name: '泓文', continuationMarks: ["''"] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records[0].isNewCustomer, true);
  assert.equal(records[1].isNewCustomer, false);
});

test('兩組各自獨立的同行(不同欄位/不同師傅時段)：各自的編號不會互相影響', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[1, '林先生', null], [3, '黃小姐', null]],
        1: [[1, "''", null], [3, "''", null]],
      },
    },
  ]);
  const master = { name: '泓文', continuationMarks: ["''"] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 4);
  const names = records.map((r) => r.customerName).sort();
  assert.deepEqual(names, ['林先生', '林先生-同行', '黃小姐', '黃小姐-同行']);
});

test('空白色塊(休假)後面接延續符號：不會被誤接成同行者，落到「找不到可延續對象」的 needsReview', async () => {
  const rows = buildSheetRows([
    {
      dateSerials: FULL_WEEK_SERIALS,
      slots: {
        0: [[1, '', '#FF0000']], // 休假
        1: [[1, "''", null]], // 緊接著一個延續符號，前面不是真人預約
      },
    },
  ]);
  const master = { name: '泓文', continuationMarks: ["''"] };
  const records = await parseGridIntoRecords(rows, master);
  assert.equal(records.length, 2);
  assert.equal(records[0].customerName, '休假');
  assert.equal(records[1].customerName, "''");
  assert.equal(records[1].needsReview, true);
  assert.match(records[1].reviewReasons[0], /沒有東西可以延續/);
});

// ===== 月份 cache(ensureMonthCached / fetchAndParseWeekCached) =====

test('ensureMonthCached: 同一個月份重複查詢，只會真的抓一次', async () => {
  let fetchCount = 0;
  const cache = new Map();
  const deps = {
    fetchAndParseMonth: async () => {
      fetchCount++;
      return [{ date: '2026-07-06', customerName: 'x' }];
    },
  };
  await ensureMonthCached({}, 2026, 7, cache, deps);
  await ensureMonthCached({}, 2026, 7, cache, deps);
  await ensureMonthCached({}, 2026, 7, cache, deps);
  assert.equal(fetchCount, 1, '三次查同一個月份，底層抓取函式只該被呼叫一次');
});

test('ensureMonthCached: 不同月份各自抓一次，不會互相干擾', async () => {
  let fetchCalls = [];
  const cache = new Map();
  const deps = {
    fetchAndParseMonth: async (env, year, month) => {
      fetchCalls.push(`${year}-${month}`);
      return [];
    },
  };
  await ensureMonthCached({}, 2026, 6, cache, deps);
  await ensureMonthCached({}, 2026, 7, cache, deps);
  await ensureMonthCached({}, 2026, 6, cache, deps); // 6月再查一次，不該重抓
  assert.deepEqual(fetchCalls, ['2026-6', '2026-7']);
});

test('fetchAndParseWeekCached: 一般週(沒跨月)，結果篩選成該週 7 天', async () => {
  const cache = new Map();
  const julyRecords = [
    { date: '2026-07-06', customerName: 'A' }, // 這週的週一
    { date: '2026-07-13', customerName: 'B' }, // 下一週的週一，不在這週範圍內
  ];
  const deps = { fetchAndParseMonth: async () => julyRecords };
  const records = await fetchAndParseWeekCached({}, '2026-07-06', cache, deps);
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, 'A');
});

test('fetchAndParseWeekCached: 跨月的週，正確合併兩個月份 cache 的資料，不遺漏', async () => {
  const cache = new Map();
  const deps = {
    fetchAndParseMonth: async (env, year, month) => {
      if (month === 6) return [{ date: '2026-06-29', customerName: '六月底' }, { date: '2026-06-30', customerName: '六月底2' }];
      if (month === 7) return [{ date: '2026-07-01', customerName: '七月初' }, { date: '2026-07-05', customerName: '七月初2' }];
      return [];
    },
  };
  // 2026-06-29(週一) ~ 2026-07-05(週日)，跨 6月/7月
  const records = await fetchAndParseWeekCached({}, '2026-06-29', cache, deps);
  const names = records.map((r) => r.customerName).sort();
  assert.deepEqual(names, ['七月初', '七月初2', '六月底', '六月底2']);
});

test('fetchAndParseWeekCached: 同一輪同步裡多個週共用同一個月份，月份分頁只抓一次(核心效益)', async () => {
  const cache = new Map();
  let fetchCalls = [];
  const deps = {
    fetchAndParseMonth: async (env, year, month) => {
      fetchCalls.push(`${year}-${month}`);
      return [
        { date: '2026-07-06', customerName: 'A' },
        { date: '2026-07-13', customerName: 'B' },
        { date: '2026-07-20', customerName: 'C' },
      ];
    },
  };
  // 7月裡三個不同的週，都落在同一個月份分頁裡
  const week1 = await fetchAndParseWeekCached({}, '2026-07-06', cache, deps);
  const week2 = await fetchAndParseWeekCached({}, '2026-07-13', cache, deps);
  const week3 = await fetchAndParseWeekCached({}, '2026-07-20', cache, deps);

  assert.equal(fetchCalls.length, 1, '三個週都在同一個月份，底層月份抓取只該打一次 API');
  assert.equal(week1[0].customerName, 'A');
  assert.equal(week2[0].customerName, 'B');
  assert.equal(week3[0].customerName, 'C');
});
