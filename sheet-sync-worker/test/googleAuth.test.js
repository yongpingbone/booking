import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verify as nodeVerify } from 'node:crypto';
import { getAccessToken, signAssertionJwt, base64UrlEncode, _resetTokenCacheForTests } from '../src/googleAuth.js';

const TEST_PRIVATE_KEY = readFileSync(new URL('./fixtures_test_private_key.pem', import.meta.url), 'utf8');
const TEST_PUBLIC_KEY = readFileSync(new URL('./fixtures_test_public_key.pem', import.meta.url), 'utf8');

function b64urlDecodeJson(part) {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(part.length + ((4 - (part.length % 4)) % 4), '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

const FAKE_SERVICE_ACCOUNT = {
  client_email: 'sheets-sync@example-project.iam.gserviceaccount.com',
  private_key: TEST_PRIVATE_KEY,
  token_uri: 'https://oauth2.googleapis.com/token',
};

test.beforeEach(() => {
  _resetTokenCacheForTests();
});

test('signAssertionJwt: 產生的 JWT 有正確的三段結構跟 header', async () => {
  const jwt = await signAssertionJwt(FAKE_SERVICE_ACCOUNT, 1_800_000_000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  const header = b64urlDecodeJson(parts[0]);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
});

test('signAssertionJwt: claims 內容正確(iss/scope/aud/iat/exp)', async () => {
  const jwt = await signAssertionJwt(FAKE_SERVICE_ACCOUNT, 1_800_000_000);
  const claims = b64urlDecodeJson(jwt.split('.')[1]);
  assert.equal(claims.iss, FAKE_SERVICE_ACCOUNT.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.iat, 1_800_000_000);
  assert.equal(claims.exp, 1_800_003_600);
});

test('signAssertionJwt: 簽章要能被獨立的驗證方式(node:crypto.verify，不是同一套程式碼)驗證通過', async () => {
  const jwt = await signAssertionJwt(FAKE_SERVICE_ACCOUNT, 1_800_000_000);
  const [headerPart, claimsPart, sigPart] = jwt.split('.');
  const signedContent = `${headerPart}.${claimsPart}`;
  const sigBase64 = sigPart.replace(/-/g, '+').replace(/_/g, '/').padEnd(sigPart.length + ((4 - (sigPart.length % 4)) % 4), '=');
  const signature = Buffer.from(sigBase64, 'base64');

  const isValid = nodeVerify('RSA-SHA256', Buffer.from(signedContent), TEST_PUBLIC_KEY, signature);
  assert.equal(isValid, true, 'JWT 簽章必須能被獨立的 RSA-SHA256 驗證通過，不能只是格式對但簽章是錯的');
});

test('signAssertionJwt: 用錯的公鑰驗證要失敗(確保上面那個 test 真的有測到東西，不是永遠回傳 true)', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { publicKey: wrongPublicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwt = await signAssertionJwt(FAKE_SERVICE_ACCOUNT, 1_800_000_000);
  const [headerPart, claimsPart, sigPart] = jwt.split('.');
  const sigBase64 = sigPart.replace(/-/g, '+').replace(/_/g, '/').padEnd(sigPart.length + ((4 - (sigPart.length % 4)) % 4), '=');
  const signature = Buffer.from(sigBase64, 'base64');
  const isValid = nodeVerify('RSA-SHA256', Buffer.from(`${headerPart}.${claimsPart}`), wrongPublicKey, signature);
  assert.equal(isValid, false);
});

test('getAccessToken: 用假的 fetch 回應正確換到 token', async () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(FAKE_SERVICE_ACCOUNT) };
  let capturedUrl, capturedBody;
  const fakeFetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = options.body.toString();
    return {
      ok: true,
      json: async () => ({ access_token: 'fake-token-123', expires_in: 3600 }),
    };
  };

  const token = await getAccessToken(env, { fetch: fakeFetch, now: () => 1_800_000_000_000 });
  assert.equal(token, 'fake-token-123');
  assert.equal(capturedUrl, 'https://oauth2.googleapis.com/token');
  assert.ok(capturedBody.includes('grant_type=urn'));
  assert.ok(capturedBody.includes('assertion='));
});

test('getAccessToken: 在有效期內重複呼叫要用 cache，不要重複換 token', async () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(FAKE_SERVICE_ACCOUNT) };
  let callCount = 0;
  const fakeFetch = async () => {
    callCount++;
    return { ok: true, json: async () => ({ access_token: `token-${callCount}`, expires_in: 3600 }) };
  };

  const now = 1_800_000_000_000;
  const token1 = await getAccessToken(env, { fetch: fakeFetch, now: () => now });
  const token2 = await getAccessToken(env, { fetch: fakeFetch, now: () => now + 1000 });
  assert.equal(token1, token2);
  assert.equal(callCount, 1);
});

test('getAccessToken: 快過期時(剩不到 60 秒)要重新換 token，不要用快過期的 cache', async () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(FAKE_SERVICE_ACCOUNT) };
  let callCount = 0;
  const fakeFetch = async () => {
    callCount++;
    return { ok: true, json: async () => ({ access_token: `token-${callCount}`, expires_in: 3600 }) };
  };

  const now = 1_800_000_000_000;
  await getAccessToken(env, { fetch: fakeFetch, now: () => now });
  // 快轉到只剩 30 秒過期(< 60 秒的安全緩衝)
  await getAccessToken(env, { fetch: fakeFetch, now: () => now + 3600 * 1000 - 30 * 1000 });
  assert.equal(callCount, 2);
});

test('getAccessToken: token endpoint 回錯誤狀態碼要丟出清楚的錯誤', async () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(FAKE_SERVICE_ACCOUNT) };
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'invalid_grant' });
  await assert.rejects(() => getAccessToken(env, { fetch: fakeFetch }), /HTTP 401/);
});

test('getAccessToken: 缺少 env.GOOGLE_SERVICE_ACCOUNT_JSON 要丟清楚的錯誤', async () => {
  await assert.rejects(() => getAccessToken({}), /GOOGLE_SERVICE_ACCOUNT_JSON/);
});

test('getAccessToken: JSON 格式錯誤要丟清楚的錯誤', async () => {
  await assert.rejects(() => getAccessToken({ GOOGLE_SERVICE_ACCOUNT_JSON: '{not valid json' }), /不是合法 JSON/);
});

test('getAccessToken: 缺 client_email 或 private_key 欄位要丟清楚的錯誤', async () => {
  await assert.rejects(
    () => getAccessToken({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'x@example.com' }) }),
    /缺少 client_email 或 private_key/
  );
});

test('base64UrlEncode: 不能包含 +, /, = 這些標準 base64 字元(URL-safe)', () => {
  const bytes = new Uint8Array([251, 255, 190, 255, 254]); // 故意選會產生 +// 的 byte pattern
  const encoded = base64UrlEncode(bytes);
  assert.ok(!/[+/=]/.test(encoded), `不該包含標準 base64 字元，實際: ${encoded}`);
});
