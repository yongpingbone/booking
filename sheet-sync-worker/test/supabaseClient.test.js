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
