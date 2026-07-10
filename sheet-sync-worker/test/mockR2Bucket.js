// mockR2Bucket.js
//
// 最小可用的 R2Bucket binding 模擬，只實作 snapshotStore.js 會用到的行為：
//   - get(key) 找不到回傳 null(不是丟例外，這點跟真的 R2 binding 一致)
//   - put(key, value) value 是字串
//   - list({prefix, limit}) 回傳 { objects: [{key}], truncated: false }
//   - delete(key)
//
// 這不是要 100%還原 R2 的所有行為，只是要讓 snapshotStore.js 的邏輯可以在
// 沒有真的 R2 bucket 的情況下被測試到。

class MockR2Bucket {
  constructor() {
    /** @type {Map<string, string>} */
    this.store = new Map();
  }

  async put(key, value) {
    this.store.set(key, value);
    return { key };
  }

  async get(key) {
    if (!this.store.has(key)) return null;
    const raw = this.store.get(key);
    return {
      key,
      text: async () => raw,
      json: async () => JSON.parse(raw),
    };
  }

  async delete(key) {
    this.store.delete(key);
  }

  async list({ prefix = '', limit = 1000 } = {}) {
    const objects = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .slice(0, limit)
      .map((key) => ({ key }));
    return { objects, truncated: false, cursor: undefined };
  }
}

export { MockR2Bucket };
