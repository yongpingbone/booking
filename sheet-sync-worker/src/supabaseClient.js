// supabaseClient.js
//
// 跟 Supabase REST API(PostgREST)溝通，把驗證過的預約寫進 bookings 表。
// 用 service role key 繞過 RLS —— 這是後端服務對服務的寫入，不是使用者操作，
// 沿用既有 Edge Functions 的模式(dual-auth 的內部呼叫那一側)。
//
// env 需要：
//   SUPABASE_PROJECT_REF        ("ikzyzkhuireqztbhrtna")，不是密鑰，可以直接寫在 vars 裡
//   SUPABASE_SERVICE_ROLE_KEY   要用 `wrangler secret put` 設，不要寫進 wrangler.toml
//
// 真實的 unique index(idx_unique_master_datetime)是 partial index：
//   UNIQUE (master_id, date, start_time)
//   WHERE date IS NOT NULL AND start_time IS NOT NULL
//     AND status <> 'cancelled' AND status <> 'no_show'
// PostgREST 的 on_conflict= 參數沒辦法帶 WHERE 條件，沒辦法正確對到 partial
// unique index(試過，直接 42P10)。所以這裡不用 Postgres 原生 upsert，改成
// 明確的「先查有沒有現成那筆、有就 PATCH、沒有就 POST」，邏輯上完全對齊
// 那個 partial index 的條件(因為判斷「有沒有現成那筆」本來就是靠
// findBookingAtSlot，那支查詢已經排除 cancelled/no_show 了)。

/**
 * @param {object} env
 * @param {object} row 已經通過 validate.js 驗證、欄位名稱對齊 bookings 表的物件
 * @param {string|null} existingId 有值就 PATCH 這筆既有資料；null 就新增一筆
 * @returns {Promise<object>} PostgREST 回傳、寫入後的那筆資料
 */
async function saveBooking(env, row, existingId) {
  if (!env.SUPABASE_PROJECT_REF) throw new Error('缺少 env.SUPABASE_PROJECT_REF');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('缺少 env.SUPABASE_SERVICE_ROLE_KEY(要用 wrangler secret put 設)');

  const url = new URL(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1/bookings`);
  const method = existingId ? 'PATCH' : 'POST';
  if (existingId) url.searchParams.set('id', `eq.${existingId}`);

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${method === 'PATCH' ? '更新' : '新增'}失敗 (HTTP ${res.status}): ${text}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

/**
 * 抓所有在職師傅（id + name），用來把 Sheet 上的師傅姓名對回 UUID。
 * 對照師傅端 app 裡 CSV 匯入用的同一條查詢：sb.from("masters").select("*").eq("is_active", true)
 * @param {object} env
 * @returns {Promise<{id: string, name: string}[]>}
 */
async function fetchActiveMasters(env) {
  if (!env.SUPABASE_PROJECT_REF) throw new Error('缺少 env.SUPABASE_PROJECT_REF');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('缺少 env.SUPABASE_SERVICE_ROLE_KEY');

  const url = new URL(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1/masters`);
  url.searchParams.set('select', 'id,name');
  url.searchParams.set('is_active', 'eq.true');

  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase 查詢 masters 失敗 (HTTP ${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * 查某個師傅在某個確切日期時間的既有預約(用來判斷排班衝突)。
 * 排除 cancelled / no_show，對照師傅端 app CSV 匯入的排除邏輯。
 * @param {object} env
 * @param {{masterId: string, date: string, startTime: string}} slot startTime 格式 "HH:MM"
 * @returns {Promise<{id: string, customer_name: string} | null>}
 */
async function findBookingAtSlot(env, { masterId, date, startTime }) {
  if (!env.SUPABASE_PROJECT_REF) throw new Error('缺少 env.SUPABASE_PROJECT_REF');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('缺少 env.SUPABASE_SERVICE_ROLE_KEY');

  const url = new URL(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1/bookings`);
  url.searchParams.set('select', 'id,customer_name,status');
  url.searchParams.set('master_id', `eq.${masterId}`);
  url.searchParams.set('date', `eq.${date}`);
  url.searchParams.set('start_time', `eq.${startTime}:00`);
  url.searchParams.set('status', 'not.in.(cancelled,no_show)');
  url.searchParams.set('limit', '1');

  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase 查詢 bookings 衝突失敗 (HTTP ${res.status}): ${text}`);
  }
  const rows = await res.json();
  return rows[0] ?? null;
}

export { saveBooking, fetchActiveMasters, findBookingAtSlot };

// ===== 以下兩支只有 reconcile.js 的一次性月份校正功能會用到 =====

/**
 * 抓某個月份全部還算「有效」的預約(排除 cancelled/no_show)，用來跟 Sheet
 * 內容比對，找出「DB 有、Sheet 沒有」的那些。
 * @param {object} env
 * @param {{year: number, month: number}} params month 1-12
 * @returns {Promise<{id: string, master_id: string, date: string, start_time: string, customer_name: string, booking_source: string}[]>}
 */
async function fetchBookingsInMonth(env, { year, month }) {
  if (!env.SUPABASE_PROJECT_REF) throw new Error('缺少 env.SUPABASE_PROJECT_REF');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('缺少 env.SUPABASE_SERVICE_ROLE_KEY');

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const endDate = `${nextMonth.y}-${String(nextMonth.m).padStart(2, '0')}-01`;

  const url = new URL(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1/bookings`);
  url.searchParams.set('select', 'id,master_id,date,start_time,customer_name,booking_source');
  url.searchParams.set('date', `gte.${startDate}`);
  url.searchParams.append('date', `lt.${endDate}`);
  url.searchParams.set('status', 'not.in.(cancelled,no_show)');
  url.searchParams.set('limit', '5000');

  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase 查詢月份預約失敗 (HTTP ${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * 把一筆預約標記成取消——不是刪除，資料還在，可以回頭查。
 * @param {object} env
 * @param {string} id
 * @returns {Promise<void>}
 */
/**
 * 把一筆預約設成指定的狀態——比 cancelBooking 更泛用，用來復原
 * (例如把誤取消的預約改回 'confirmed')，不是只能取消。
 * @param {object} env
 * @param {string} id
 * @param {string} status
 * @returns {Promise<void>}
 */
async function setBookingStatus(env, id, status) {
  if (!env.SUPABASE_PROJECT_REF) throw new Error('缺少 env.SUPABASE_PROJECT_REF');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('缺少 env.SUPABASE_SERVICE_ROLE_KEY');

  const url = new URL(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1/bookings`);
  url.searchParams.set('id', `eq.${id}`);

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase 設定狀態失敗 (HTTP ${res.status}): ${text}`);
  }
}

export { setBookingStatus };

async function cancelBooking(env, id) {
  if (!env.SUPABASE_PROJECT_REF) throw new Error('缺少 env.SUPABASE_PROJECT_REF');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('缺少 env.SUPABASE_SERVICE_ROLE_KEY');

  const url = new URL(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1/bookings`);
  url.searchParams.set('id', `eq.${id}`);

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ status: 'cancelled' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase 取消預約失敗 (HTTP ${res.status}): ${text}`);
  }
}

export { fetchBookingsInMonth, cancelBooking };

// Google Sheets 常見的公式錯誤殘留字串——needsReview 沒有真的被檢查之前，
// 這些可能被當成真實客戶姓名寫進資料庫。之前只抓過 #REF!，這裡一次列
// 完整，避免只清一種、其他種類的殘留繼續卡著。
const KNOWN_FORMULA_ERROR_STRINGS = ['#REF!', '#DIV/0!', '#N/A', '#VALUE!', '#NAME?', '#NULL!', '#NUM!', '#ERROR!'];

/**
 * 找出 customer_name 剛好等於已知公式錯誤字串的預約(不分大小寫)——用來
 * 清理 needsReview 標記形同虛設那段期間，被誤當成真實姓名寫進去的壞資料。
 * @param {object} env
 * @returns {Promise<Array<object>>}
 */
async function findGarbageBookings(env) {
  if (!env.SUPABASE_PROJECT_REF) throw new Error('缺少 env.SUPABASE_PROJECT_REF');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('缺少 env.SUPABASE_SERVICE_ROLE_KEY');

  const url = new URL(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1/bookings`);
  url.searchParams.set('select', 'id,master_id,date,start_time,customer_name,booking_source,status,created_at');
  url.searchParams.set('customer_name', `in.(${KNOWN_FORMULA_ERROR_STRINGS.map((s) => `"${s}"`).join(',')})`);
  url.searchParams.set('status', 'not.in.(cancelled)');
  url.searchParams.set('limit', '1000');

  const res = await fetch(url, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase 查詢壞資料失敗 (HTTP ${res.status}): ${text}`);
  }
  return res.json();
}

export { findGarbageBookings, KNOWN_FORMULA_ERROR_STRINGS };
