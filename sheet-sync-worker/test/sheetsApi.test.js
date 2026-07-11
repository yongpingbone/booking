import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGridRows, normalizeCell, colorObjectToHex, getSheetIdByTitle, setCellNote, getCellNote, listSheetTabs, scanTabForNotes, _resetSheetIdCacheForTests } from '../src/sheetsApi.js';

test('colorObjectToHex: 黃色 {r:1,g:1,b:0} 要轉成 #FFFF00(對應實際 Sheet 裡確認過的 FFFFFF00 新客標記，扣掉 alpha)', () => {
  assert.equal(colorObjectToHex({ red: 1, green: 1, blue: 0 }), '#FFFF00');
});

test('colorObjectToHex: 白色 {r:1,g:1,b:1}', () => {
  assert.equal(colorObjectToHex({ red: 1, green: 1, blue: 1 }), '#FFFFFF');
});

test('colorObjectToHex: 沒有顏色物件(undefined/null) → null，不是丟錯或回傳假資料', () => {
  assert.equal(colorObjectToHex(undefined), null);
  assert.equal(colorObjectToHex(null), null);
});

test('colorObjectToHex: 缺 green/blue 欄位時當成 0(Sheets API 對 0 有時會省略該欄位)', () => {
  assert.equal(colorObjectToHex({ red: 1 }), '#FF0000');
});

test('normalizeCell: 文字內容', () => {
  const cell = { userEnteredValue: { stringValue: '王小明' }, effectiveFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } };
  const result = normalizeCell(cell);
  assert.equal(result.value, '王小明');
  assert.equal(result.colorHex, '#FFFFFF');
});

test('normalizeCell: 數字內容(日期/時間的序列數字都是 numberValue)', () => {
  const cell = { userEnteredValue: { numberValue: 46204 } };
  const result = normalizeCell(cell);
  assert.equal(result.value, 46204);
});

test('normalizeCell: 空格子(完全沒有 userEnteredValue)', () => {
  const result = normalizeCell({});
  assert.equal(result.value, null);
  assert.equal(result.colorHex, null);
});

test('normalizeCell: null/undefined 輸入也要安全處理', () => {
  assert.deepEqual(normalizeCell(null), { value: null, colorHex: null });
  assert.deepEqual(normalizeCell(undefined), { value: null, colorHex: null });
});

test('normalizeCell: 公式格子退回用 formattedValue(不解析公式本身)', () => {
  const cell = { userEnteredValue: { formulaValue: '=A1' }, formattedValue: '計算結果' };
  const result = normalizeCell(cell);
  assert.equal(result.value, '計算結果');
});

test('fetchGridRows: 正確組出 URL 參數，並把巢狀回應轉成簡單陣列', async () => {
  let capturedUrl;
  const fakeFetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      json: async () => ({
        sheets: [
          {
            properties: { title: '7月-麒' },
            data: [
              {
                rowData: [
                  { values: [{ userEnteredValue: { stringValue: '週日' } }, { userEnteredValue: { stringValue: '週一' } }] },
                  { values: [{ userEnteredValue: { numberValue: 46204 } }] },
                ],
              },
            ],
          },
        ],
      }),
    };
  };

  const env = { GOOGLE_SHEET_ID: 'sheet-abc-123' };
  const result = await fetchGridRows(env, { sheetTitle: '7月-麒', range: 'A1:H1006', accessToken: 'tok' }, { fetch: fakeFetch });

  assert.equal(result.title, '7月-麒');
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0][0].value, '週日');
  assert.equal(result.rows[1][0].value, 46204);

  assert.ok(capturedUrl.toString().includes('sheet-abc-123'));
  const parsedUrl = new URL(capturedUrl.toString());
  assert.equal(parsedUrl.searchParams.get('ranges'), "'7月-麒'!A1:H1006");
  assert.equal(parsedUrl.searchParams.get('includeGridData'), 'true');
});

test('fetchGridRows: 分頁名稱裡有單引號要正確跳脫', async () => {
  let capturedUrl;
  const fakeFetch = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ sheets: [{ properties: { title: "x" }, data: [{ rowData: [] }] }] }) };
  };
  await fetchGridRows(
    { GOOGLE_SHEET_ID: 'id' },
    { sheetTitle: "5月-麒's copy", range: 'A1:A1', accessToken: 't' },
    { fetch: fakeFetch }
  );
  const parsedUrl = new URL(capturedUrl.toString());
  assert.equal(parsedUrl.searchParams.get('ranges'), "'5月-麒''s copy'!A1:A1");
});

test('fetchGridRows: API 回傳非 2xx 要丟清楚的錯誤', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, text: async () => 'permission denied' });
  await assert.rejects(
    () => fetchGridRows({ GOOGLE_SHEET_ID: 'id' }, { sheetTitle: 'x', range: 'A1:A1', accessToken: 't' }, { fetch: fakeFetch }),
    /HTTP 403/
  );
});

test('fetchGridRows: 回應裡找不到分頁資料(例如分頁名稱打錯)要丟清楚的錯誤', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ sheets: [] }) });
  await assert.rejects(
    () => fetchGridRows({ GOOGLE_SHEET_ID: 'id' }, { sheetTitle: '不存在的分頁', range: 'A1:A1', accessToken: 't' }, { fetch: fakeFetch }),
    /不存在的分頁/
  );
});

test('fetchGridRows: 缺少 env.GOOGLE_SHEET_ID 要丟清楚的錯誤', async () => {
  await assert.rejects(() => fetchGridRows({}, { sheetTitle: 'x', range: 'A1:A1', accessToken: 't' }));
});

test('getSheetIdByTitle: 重複查同一個/不同分頁名稱，只打一次 API(快取住整份分頁清單)', async () => {
  _resetSheetIdCacheForTests();
  let callCount = 0;
  const fakeFetch = async () => {
    callCount++;
    return {
      ok: true,
      json: async () => ({
        sheets: [
          { properties: { sheetId: 111, title: '7月-泓文' } },
          { properties: { sheetId: 222, title: '7月-麒' } },
        ],
      }),
    };
  };
  const env = { GOOGLE_SHEET_ID: 'id' };

  const id1 = await getSheetIdByTitle(env, { sheetTitle: '7月-泓文', accessToken: 't' }, { fetch: fakeFetch });
  const id2 = await getSheetIdByTitle(env, { sheetTitle: '7月-麒', accessToken: 't' }, { fetch: fakeFetch });
  const id3 = await getSheetIdByTitle(env, { sheetTitle: '7月-泓文', accessToken: 't' }, { fetch: fakeFetch });

  assert.equal(id1, 111);
  assert.equal(id2, 222);
  assert.equal(id3, 111);
  assert.equal(callCount, 1, '三次查詢(含重複的)應該只打一次 API，其餘從快取拿');
});

test('getSheetIdByTitle: 快取過期後(超過 TTL)要重新打 API', async () => {
  _resetSheetIdCacheForTests();
  let callCount = 0;
  let fakeNow = 1_000_000;
  const fakeFetch = async () => {
    callCount++;
    return { ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 111, title: 'x' } }] }) };
  };
  const env = { GOOGLE_SHEET_ID: 'id' };
  const deps = { fetch: fakeFetch, now: () => fakeNow };

  await getSheetIdByTitle(env, { sheetTitle: 'x', accessToken: 't' }, deps);
  assert.equal(callCount, 1);

  fakeNow += 4 * 60 * 1000; // 4 分鐘後，還在 5 分鐘 TTL 內
  await getSheetIdByTitle(env, { sheetTitle: 'x', accessToken: 't' }, deps);
  assert.equal(callCount, 1, '還沒過期，不該重新打 API');

  fakeNow += 2 * 60 * 1000; // 再過 2 分鐘，總共 6 分鐘，超過 TTL
  await getSheetIdByTitle(env, { sheetTitle: 'x', accessToken: 't' }, deps);
  assert.equal(callCount, 2, '過期後應該重新打一次 API');
});

test('getSheetIdByTitle: 快取裡沒有的分頁名稱(例如新加的分頁)要強制重新查一次，不要直接報錯', async () => {
  _resetSheetIdCacheForTests();
  let callCount = 0;
  const responses = [
    { sheets: [{ properties: { sheetId: 111, title: '7月-泓文' } }] },
    { sheets: [{ properties: { sheetId: 111, title: '7月-泓文' } }, { properties: { sheetId: 999, title: '7月-新分頁' } }] },
  ];
  const fakeFetch = async () => {
    const body = responses[callCount];
    callCount++;
    return { ok: true, json: async () => body };
  };
  const env = { GOOGLE_SHEET_ID: 'id' };

  await getSheetIdByTitle(env, { sheetTitle: '7月-泓文', accessToken: 't' }, { fetch: fakeFetch });
  assert.equal(callCount, 1);

  const id = await getSheetIdByTitle(env, { sheetTitle: '7月-新分頁', accessToken: 't' }, { fetch: fakeFetch });
  assert.equal(id, 999);
  assert.equal(callCount, 2, '快取裡沒有的分頁名稱要重新查一次');
});

test('getSheetIdByTitle: 真的找不到的分頁名稱要丟清楚的錯誤', async () => {
  _resetSheetIdCacheForTests();
  const fakeFetch = async () => ({ ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 111, title: 'x' } }] }) });
  await assert.rejects(
    () => getSheetIdByTitle({ GOOGLE_SHEET_ID: 'id' }, { sheetTitle: '真的不存在', accessToken: 't' }, { fetch: fakeFetch }),
    /找不到分頁「真的不存在」/
  );
});

test('setCellNote: 組出正確的 batchUpdate request body，只更新 note 欄位', async () => {
  _resetSheetIdCacheForTests();
  let capturedBody;
  const fakeFetch = async (url, options) => {
    if (url.toString().includes(':batchUpdate')) {
      capturedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ sheets: [{ properties: { sheetId: 42, title: '7月-泓文' } }] }) };
  };
  await setCellNote(
    { GOOGLE_SHEET_ID: 'id' },
    { sheetTitle: '7月-泓文', rowIndex: 5, colIndex: 2, note: '⚠️ 測試', accessToken: 't' },
    { fetch: fakeFetch }
  );
  const req = capturedBody.requests[0].updateCells;
  assert.equal(req.range.sheetId, 42);
  assert.equal(req.range.startRowIndex, 5);
  assert.equal(req.range.startColumnIndex, 2);
  assert.equal(req.fields, 'note');
  assert.equal(req.rows[0].values[0].note, '⚠️ 測試');
});

test('getCellNote: 讀正確的 A1 座標，回傳 note/實際分頁 id/標題', async () => {
  let capturedUrl;
  const fakeFetch = async (url) => {
    capturedUrl = url.toString();
    return {
      ok: true,
      json: async () => ({
        sheets: [
          {
            properties: { sheetId: 42, title: '7月-麒' },
            data: [{ rowData: [{ values: [{ note: '⚠️ 同步失敗：找不到師傅「許老師」', formattedValue: 'Kelie' }] }] }],
          },
        ],
      }),
    };
  };
  const result = await getCellNote(
    { GOOGLE_SHEET_ID: 'id' },
    { sheetTitle: '7月-麒', rowIndex: 48, colIndex: 5, accessToken: 't' },
    { fetch: fakeFetch }
  );
  assert.ok(capturedUrl.includes('F49'), 'row 48(0-indexed)+col 5(0-indexed=F) 應該轉成 A1 座標 F49');
  assert.equal(result.note, '⚠️ 同步失敗：找不到師傅「許老師」');
  assert.equal(result.actualSheetId, 42);
  assert.equal(result.actualSheetTitle, '7月-麒');
  assert.equal(result.formattedValue, 'Kelie');
});

test('getCellNote: 沒有備註時回傳 null，不是丟錯', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      sheets: [{ properties: { sheetId: 1, title: 'x' }, data: [{ rowData: [{ values: [{}] }] }] }],
    }),
  });
  const result = await getCellNote({ GOOGLE_SHEET_ID: 'id' }, { sheetTitle: 'x', rowIndex: 0, colIndex: 0, accessToken: 't' }, { fetch: fakeFetch });
  assert.equal(result.note, null);
});

test('listSheetTabs: 回傳所有分頁的 title/sheetId 清單', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      sheets: [
        { properties: { sheetId: 1, title: '7月-麒' } },
        { properties: { sheetId: 2, title: '7月-治' } },
      ],
    }),
  });
  const tabs = await listSheetTabs({ GOOGLE_SHEET_ID: 'id' }, { accessToken: 't' }, { fetch: fakeFetch });
  assert.deepEqual(tabs, [
    { title: '7月-麒', sheetId: 1 },
    { title: '7月-治', sheetId: 2 },
  ]);
});

test('scanTabForNotes: 找出範圍內所有掛著非空備註的格子，忽略沒有備註的格子', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      sheets: [
        {
          data: [
            {
              rowData: [
                { values: [{}, { note: '舊備註A' }, {}] },
                { values: [{}, {}, { note: '舊備註B' }] },
                { values: [{}, {}, {}] },
              ],
            },
          ],
        },
      ],
    }),
  });
  const found = await scanTabForNotes({ GOOGLE_SHEET_ID: 'id' }, { sheetTitle: 'x', range: 'A1:C3', accessToken: 't' }, { fetch: fakeFetch });
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], { rowIndex: 0, colIndex: 1, note: '舊備註A' });
  assert.deepEqual(found[1], { rowIndex: 1, colIndex: 2, note: '舊備註B' });
});

test('scanTabForNotes: 完全沒有備註時回傳空陣列', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ sheets: [{ data: [{ rowData: [{ values: [{}, {}] }] }] }] }),
  });
  const found = await scanTabForNotes({ GOOGLE_SHEET_ID: 'id' }, { sheetTitle: 'x', range: 'A1:B1', accessToken: 't' }, { fetch: fakeFetch });
  assert.deepEqual(found, []);
});
