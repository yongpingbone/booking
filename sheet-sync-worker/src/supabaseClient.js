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
// on_conflict 用哪個欄位(或哪組欄位組合)當唯一鍵，要看 bookings 表實際的
// unique constraint 是怎麼下的 —— 這裡先開放成參數，等 schema 確認後
// 在 index.js 呼叫時固定下來即可，這支本身不用再改。

/**
 * @param {object} env
 * @param {object} row 已經通過 validate.js 驗證、欄位名稱對齊 bookings 表的物件
 * @param {string} onConflictColumns 例如 "master_id,start_time" —— 對應 bookings 的 unique constraint
 * @returns {Promise<object>} PostgREST 回傳、寫入後的那筆資料
 */
async function upsertBooking(env, row, onConflictColumns) {
  if (!env.SUPABASE_PROJECT_REF) throw new Error('缺少 env.SUPABASE_PROJECT_REF');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('缺少 env.SUPABASE_SERVICE_ROLE_KEY(要用 wrangler secret put 設)');
  if (!onConflictColumns) throw new Error('缺少 onConflictColumns —— bookings 表 upsert 要指定衝突判斷用的欄位');

  const url = new URL(`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1/bookings`);
  url.searchParams.set('on_conflict', onConflictColumns);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase upsert 失敗 (HTTP ${res.status}): ${text}`);
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

export { upsertBooking, fetchActiveMasters, findBookingAtSlot };
