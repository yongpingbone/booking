// sheetsApi.js
//
// 只做一件事：呼叫 Sheets API v4 拿某個分頁某個範圍的格子內容(值+底色)，
// 轉成簡單的 { value, colorHex } 二維陣列。Google API 回傳的巢狀結構本身
// 複雜、容易寫錯，集中在這一支處理，其他地方(sheetParser.js)不用碰到。
//
// ⚠️ 這支需要真的打 sheets.googleapis.com，我的 sandbox 對外網路沒開放這個
// 網域，沒辦法在這裡實際跑過一次——邏輯是照 Sheets API v4 文件的既有格式寫的，
// 部署後第一次跑務必看一下 log 有沒有正常回傳資料，不要預設它一定完全正確。

/**
 * @param {number|undefined} v
 * @returns {string|null} "#RRGGBB" 或 null(沒有底色/預設白色時 Sheets 有時不會回這個欄位)
 */
function colorObjectToHex(colorObj) {
  if (!colorObj) return null;
  const toByte = (x) => Math.round((x ?? 0) * 255);
  const r = toByte(colorObj.red).toString(16).padStart(2, '0');
  const g = toByte(colorObj.green).toString(16).padStart(2, '0');
  const b = toByte(colorObj.blue).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`.toUpperCase();
}

/**
 * 把 Sheets API 回傳的一個 CellData 轉成 { value, colorHex }。
 * @param {object} cell Sheets API 的 CellData 物件
 * @returns {{value: string|number|null, colorHex: string|null}}
 */
function normalizeCell(cell) {
  if (!cell) return { value: null, colorHex: null };
  const uev = cell.userEnteredValue;
  let value = null;
  if (uev) {
    if (typeof uev.stringValue === 'string') value = uev.stringValue;
    else if (typeof uev.numberValue === 'number') value = uev.numberValue;
    else if (typeof uev.boolValue === 'boolean') value = uev.boolValue;
    else if (typeof uev.formulaValue === 'string') value = cell.formattedValue ?? null; // 有公式的格子退回顯示值
  }
  const colorHex = colorObjectToHex(cell.effectiveFormat?.backgroundColor);
  return { value, colorHex };
}

/**
 * @param {object} env 需要 env.GOOGLE_SHEET_ID
 * @param {{sheetTitle: string, range: string, accessToken: string}} params
 *   range 例如 "A1:H1006"(不含分頁名稱，分頁名稱另外傳)
 * @param {object} [deps] 測試用依賴注入：{ fetch }
 * @returns {Promise<{title: string, rows: {value: string|number|null, colorHex: string|null}[][]}>}
 */
async function fetchGridRows(env, { sheetTitle, range, accessToken }, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  if (!env.GOOGLE_SHEET_ID) throw new Error('缺少 env.GOOGLE_SHEET_ID');

  const a1Range = `'${sheetTitle.replace(/'/g, "''")}'!${range}`;
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}`);
  url.searchParams.set('includeGridData', 'true');
  url.searchParams.set('ranges', a1Range);
  url.searchParams.set(
    'fields',
    'sheets(properties.title,data.rowData.values(userEnteredValue,formattedValue,effectiveFormat.backgroundColor))'
  );

  const res = await doFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sheets API 讀取「${sheetTitle}」失敗 (HTTP ${res.status}): ${text}`);
  }

  const data = await res.json();
  const sheet = data.sheets?.[0];
  if (!sheet) throw new Error(`Sheets API 回應裡沒有分頁資料，分頁「${sheetTitle}」可能不存在`);

  const rowData = sheet.data?.[0]?.rowData ?? [];
  const rows = rowData.map((r) => (r.values ?? []).map(normalizeCell));
  return { title: sheet.properties?.title ?? sheetTitle, rows };
}

/**
 * 在指定儲存格上設定/清除備註(note)，不會動到儲存格的值或格式。
 * 用 note 而不是改儲存格內容，是為了讓寫回動作不會被下一輪同步的內容比對
 * (diff.js 用的 contentHash)當成新的異動——note 完全不影響 hashContent()
 * 有算進去的欄位。
 * @param {object} env 需要 env.GOOGLE_SHEET_ID
 * @param {{sheetTitle: string, rowIndex: number, colIndex: number, note: string|null, accessToken: string}} params
 *   rowIndex/colIndex 都是 0-indexed(A1=row0,col0)
 * @param {object} [deps] 測試用依賴注入：{ fetch }
 * @returns {Promise<void>}
 */
async function setCellNote(env, { sheetTitle, rowIndex, colIndex, note, accessToken }, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  if (!env.GOOGLE_SHEET_ID) throw new Error('缺少 env.GOOGLE_SHEET_ID');

  // batchUpdate 的 updateCells 用 sheetId(數字)定位分頁，不是分頁名稱，
  // 所以要先查一次分頁名稱對應的數字 ID。
  const sheetId = await getSheetIdByTitle(env, { sheetTitle, accessToken }, { fetch: doFetch });

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}:batchUpdate`;
  const body = {
    requests: [
      {
        updateCells: {
          range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
          rows: [{ values: [{ note: note ?? null }] }],
          fields: 'note',
        },
      },
    ],
  };

  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sheets API 寫入「${sheetTitle}」備註失敗 (HTTP ${res.status}): ${text}`);
  }
}

/**
 * 直接讀某一格「目前實際」的備註內容，跟 fetchGridRows 不一樣(那支故意只抓
 * value/顏色，沒有要 note 欄位)。診斷用：親眼確認 Google 那邊到底存了什麼，
 * 不要再靠猜的。
 * @param {object} env 需要 env.GOOGLE_SHEET_ID
 * @param {{sheetTitle: string, rowIndex: number, colIndex: number, accessToken: string}} params
 * @param {object} [deps]
 * @returns {Promise<string|null>}
 */
async function getCellNote(env, { sheetTitle, rowIndex, colIndex, accessToken }, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  if (!env.GOOGLE_SHEET_ID) throw new Error('缺少 env.GOOGLE_SHEET_ID');

  const colLetter = String.fromCharCode(65 + colIndex);
  const rowNumber = rowIndex + 1;
  const a1Range = `'${sheetTitle.replace(/'/g, "''")}'!${colLetter}${rowNumber}`;

  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}`);
  url.searchParams.set('includeGridData', 'true');
  url.searchParams.set('ranges', a1Range);
  url.searchParams.set('fields', 'sheets(properties(sheetId,title),data.rowData.values(note,userEnteredValue,formattedValue))');

  const res = await doFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sheets API 讀取備註失敗 (HTTP ${res.status}): ${text}`);
  }
  const data = await res.json();
  const sheet = data.sheets?.[0];
  const cell = sheet?.data?.[0]?.rowData?.[0]?.values?.[0];
  return {
    actualSheetId: sheet?.properties?.sheetId ?? null,
    actualSheetTitle: sheet?.properties?.title ?? null,
    note: cell?.note ?? null,
    formattedValue: cell?.formattedValue ?? null,
  };
}

/**
 * 列出整份試算表所有分頁的 (title, sheetId)，診斷用：確認有沒有重複或
 * 對不起來的分頁名稱，導致 getSheetIdByTitle 抓錯 sheetId。
 * @param {object} env
 * @param {{accessToken: string}} params
 * @param {object} [deps]
 * @returns {Promise<Array<{title: string, sheetId: number}>>}
 */
async function listSheetTabs(env, { accessToken }, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}`);
  url.searchParams.set('fields', 'sheets.properties(sheetId,title)');
  const res = await doFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sheets API 查詢分頁清單失敗 (HTTP ${res.status}): ${text}`);
  }
  const data = await res.json();
  return (data.sheets ?? []).map((s) => ({ title: s.properties?.title, sheetId: s.properties?.sheetId }));
}

// 分頁名稱 -> sheetId 的對照表快取在記憶體裡。setCellNote() 驗證失敗時可能
// 短時間內被呼叫很多次(例如一次同步有很多筆驗證失敗)，每次都重新查一次
// 分頁清單會很快打爆 Sheets API 的「每分鐘讀取次數」限制(實測撞過 429)。
// 分頁清單改變的頻率很低，快取 5 分鐘很安全。
let sheetIdCache = null; // { map: Map<title, sheetId>, cachedAtMs }
const SHEET_ID_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * @param {object} env 需要 env.GOOGLE_SHEET_ID
 * @param {{sheetTitle: string, accessToken: string}} params
 * @param {object} [deps]
 * @returns {Promise<number>} 該分頁的數字 sheetId(batchUpdate 用，不是分頁名稱)
 */
async function getSheetIdByTitle(env, { sheetTitle, accessToken }, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const nowMs = (deps.now ?? Date.now)();

  if (sheetIdCache && nowMs - sheetIdCache.cachedAtMs < SHEET_ID_CACHE_TTL_MS) {
    const cached = sheetIdCache.map.get(sheetTitle);
    if (cached !== undefined) return cached;
    // 快取裡沒有這個分頁名稱 —— 可能是新加的分頁，強制重新查一次而不是直接報錯
  }

  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}`);
  url.searchParams.set('fields', 'sheets.properties(sheetId,title)');

  const res = await doFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sheets API 查詢分頁清單失敗 (HTTP ${res.status}): ${text}`);
  }
  const data = await res.json();
  const map = new Map((data.sheets ?? []).map((s) => [s.properties?.title, s.properties?.sheetId]));
  sheetIdCache = { map, cachedAtMs: nowMs };

  const sheetId = map.get(sheetTitle);
  if (sheetId === undefined) throw new Error(`找不到分頁「${sheetTitle}」`);
  return sheetId;
}

/** 測試用：清掉 in-memory cache，避免測試之間互相汙染。 */
function _resetSheetIdCacheForTests() {
  sheetIdCache = null;
}

export { fetchGridRows, normalizeCell, colorObjectToHex, setCellNote, getSheetIdByTitle, getCellNote, listSheetTabs, _resetSheetIdCacheForTests };
