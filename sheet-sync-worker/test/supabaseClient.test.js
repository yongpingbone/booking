import test from 'node:test';
import assert from 'node:assert/strict';
import { saveBooking } from '../src/supabaseClient.js';

function makeEnv(overrides = {}) {
  return {
    SUPABASE_PROJECT_REF: 'ikzyzkhuireqztbhrtna',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
    ...overrides,
  };
}

function fakeFetchOk(row) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url: url.toString(), options });
    return {
      ok: true,
      json: async () => [row],
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

test('saveBooking: existingId=null -> POST，網址不帶 id filter', async () => {
  const env = makeEnv();
  const fetchFn = fakeFetchOk({ id: 'new-id', customer_name: '王小明' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const row = { customer_name: '王小明', master_id: 'm1' };
    const result = await saveBooking(env, row, null);
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(fetchFn.calls[0].options.method, 'POST');
    assert.ok(!fetchFn.calls[0].url.includes('id=eq.'));
    assert.deepEqual(JSON.parse(fetchFn.calls[0].options.body), row);
    assert.equal(result.id, 'new-id');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('saveBooking: existingId 有值 -> PATCH，網址帶 id=eq.<existingId>', async () => {
  const env = makeEnv();
  const fetchFn = fakeFetchOk({ id: 'existing-123', customer_name: '王小明' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const row = { customer_name: '王小明' };
    await saveBooking(env, row, 'existing-123');
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(fetchFn.calls[0].options.method, 'PATCH');
    assert.ok(fetchFn.calls[0].url.includes('id=eq.existing-123'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('saveBooking: 缺 SUPABASE_SERVICE_ROLE_KEY 要丟清楚的錯誤', async () => {
  const env = makeEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined });
  await assert.rejects(() => saveBooking(env, {}, null), /SUPABASE_SERVICE_ROLE_KEY/);
});

test('saveBooking: HTTP 非 2xx 時，錯誤訊息要分辨是「新增」還是「更新」失敗', async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '壞掉的錯誤內容' });
  try {
    await assert.rejects(() => saveBooking(env, {}, null), /新增失敗/);
    await assert.rejects(() => saveBooking(env, {}, 'abc'), /更新失敗/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBookingsInMonth: 組出正確的日期範圍查詢(7月 -> gte 7/1 且 lt 8/1)', async () => {
  const env = makeEnv();
  let capturedUrl;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    capturedUrl = url.toString();
    return { ok: true, json: async () => [] };
  };
  try {
    const { fetchBookingsInMonth } = await import('../src/supabaseClient.js');
    await fetchBookingsInMonth(env, { year: 2026, month: 7 });
    assert.ok(capturedUrl.includes('date=gte.2026-07-01'));
    assert.ok(capturedUrl.includes('date=lt.2026-08-01'));
    assert.ok(capturedUrl.includes('status=not.in.'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBookingsInMonth: 12月要正確跨年(lt 隔年1/1，不是13月)', async () => {
  const env = makeEnv();
  let capturedUrl;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    capturedUrl = url.toString();
    return { ok: true, json: async () => [] };
  };
  try {
    const { fetchBookingsInMonth } = await import('../src/supabaseClient.js');
    await fetchBookingsInMonth(env, { year: 2026, month: 12 });
    assert.ok(capturedUrl.includes('date=gte.2026-12-01'));
    assert.ok(capturedUrl.includes('date=lt.2027-01-01'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cancelBooking: PATCH 到正確的 id，body 是 status=cancelled', async () => {
  const env = makeEnv();
  let capturedUrl, capturedOptions;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url.toString();
    capturedOptions = options;
    return { ok: true };
  };
  try {
    const { cancelBooking } = await import('../src/supabaseClient.js');
    await cancelBooking(env, 'booking-abc');
    assert.ok(capturedUrl.includes('id=eq.booking-abc'));
    assert.equal(capturedOptions.method, 'PATCH');
    assert.deepEqual(JSON.parse(capturedOptions.body), { status: 'cancelled' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cancelBooking: 失敗時丟出清楚的錯誤', async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '掛了' });
  try {
    const { cancelBooking } = await import('../src/supabaseClient.js');
    await assert.rejects(() => cancelBooking(env, 'x'), /取消預約失敗/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findGarbageBookings: 組出正確的查詢條件(customer_name in 已知公式錯誤清單、排除已取消的)', async () => {
  const env = makeEnv();
  let capturedUrl;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    capturedUrl = url.toString();
    return { ok: true, json: async () => [] };
  };
  try {
    const { findGarbageBookings } = await import('../src/supabaseClient.js');
    await findGarbageBookings(env);
    assert.ok(decodeURIComponent(capturedUrl).includes('#REF!'));
    assert.ok(capturedUrl.includes('status=not.in'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findGarbageBookings: 失敗時丟出清楚的錯誤', async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '掛了' });
  try {
    const { findGarbageBookings } = await import('../src/supabaseClient.js');
    await assert.rejects(() => findGarbageBookings(env), /查詢壞資料失敗/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('setBookingStatus: PATCH 到正確的 id，body 是指定的 status', async () => {
  const env = makeEnv();
  let capturedUrl, capturedOptions;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url.toString();
    capturedOptions = options;
    return { ok: true };
  };
  try {
    const { setBookingStatus } = await import('../src/supabaseClient.js');
    await setBookingStatus(env, 'booking-abc', 'confirmed');
    assert.ok(capturedUrl.includes('id=eq.booking-abc'));
    assert.equal(capturedOptions.method, 'PATCH');
    assert.deepEqual(JSON.parse(capturedOptions.body), { status: 'confirmed' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
