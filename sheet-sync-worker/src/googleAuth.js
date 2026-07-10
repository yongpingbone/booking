// googleAuth.js
//
// 用 Google 服務帳號 JSON(env.GOOGLE_SERVICE_ACCOUNT_JSON)簽 JWT、換 access token，
// 讓 Worker 可以呼叫 Google Sheets API。全程只在 Worker 內部進行，服務帳號私鑰
// 不會離開 Worker runtime。
//
// 流程：組 JWT header+claims → 用 Web Crypto(RS256)簽章 → POST 到 Google 的
// token endpoint 換 access token → cache 在記憶體裡，過期前重複使用。
//
// 注意：cache 是模組層級的變數，同一個 Worker isolate 處理下一個請求時可能還在，
// 但不保證跨 isolate/跨部署存在，也不需要——最壞情況就是多打一次換 token 的請求。

let cachedToken = null; // { accessToken, expiresAtMs }

// ⚠️ 這裡用讀寫權限的 scope(不是 .readonly)，因為 sheetWriter.js 需要在
// 儲存格上寫備註(note)。這代表服務帳號在 Google Sheet 那邊的共用權限必須是
// 「編輯者」，不能只是「檢視者」——如果目前只有檢視權限，麻煩去 Sheet 右上角
// 共用設定，把 sheets-sync@yongpingbone.iam.gserviceaccount.com 改成編輯者。
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64UrlEncode(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

/**
 * 把 PEM 格式的 PKCS8 私鑰匯入成 CryptoKey，供 crypto.subtle.sign 使用。
 * @param {string} pem 服務帳號 JSON 裡的 private_key 欄位(含 -----BEGIN PRIVATE KEY----- 那些行)
 * @returns {Promise<CryptoKey>}
 */
async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * @param {{client_email: string, private_key: string, token_uri?: string}} serviceAccount
 * @param {number} nowSeconds
 * @returns {Promise<string>} 簽好的 JWT(還沒拿去換 token)
 */
async function signAssertionJwt(serviceAccount, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: serviceAccount.token_uri || 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claims))}`;
  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

/**
 * @param {object} env 需要 env.GOOGLE_SERVICE_ACCOUNT_JSON(字串，wrangler secret put 設的)
 * @param {object} [deps] 測試用依賴注入：{ fetch, now }
 * @returns {Promise<string>} access token
 */
async function getAccessToken(env, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const nowMs = deps.now ? deps.now() : Date.now();

  if (cachedToken && cachedToken.expiresAtMs > nowMs + 60_000) {
    return cachedToken.accessToken;
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('缺少 env.GOOGLE_SERVICE_ACCOUNT_JSON(要用 wrangler secret put 設)');

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    throw new Error(`env.GOOGLE_SERVICE_ACCOUNT_JSON 不是合法 JSON: ${err.message}`);
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('服務帳號 JSON 缺少 client_email 或 private_key 欄位');
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const assertion = await signAssertionJwt(serviceAccount, nowSeconds);
  const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';

  const res = await doFetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`跟 Google 換 access token 失敗 (HTTP ${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAtMs: nowMs + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

/** 測試用：清掉 in-memory cache，避免測試之間互相汙染。 */
function _resetTokenCacheForTests() {
  cachedToken = null;
}

export { getAccessToken, signAssertionJwt, base64UrlEncode, base64UrlEncodeString, _resetTokenCacheForTests };
