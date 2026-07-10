import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGridRows, normalizeCell, colorObjectToHex } from '../src/sheetsApi.js';

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
