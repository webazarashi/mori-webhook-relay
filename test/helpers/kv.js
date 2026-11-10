// テスト用のメモリ KV（書き込み回数を数える）
export function createMemoryKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const kv = {
    writes: 0,
    deletes: 0,
    reads: 0,
    store,
    async get(key) {
      kv.reads++;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      kv.writes++;
      store.set(key, String(value));
    },
    async delete(key) {
      kv.deletes++;
      store.delete(key);
    },
  };
  return kv;
}
