export function getStore() {
  const kv = globalThis.__STORY_JOBS;
  if (!kv) throw new Error("STORY_JOBS binding chưa sẵn sàng");
  return {
    async get(key, options) { return options?.type === "json" ? kv.get(key, { type: "json" }) : kv.get(key); },
    async getJSON(key) { return kv.get(key, { type: "json" }); },
    async setJSON(key, value) { return kv.put(key, JSON.stringify(value)); },
    async set(key, value) { return kv.put(key, typeof value === "string" ? value : JSON.stringify(value)); },
    async delete(key) { return kv.delete(key); },
    async list(options) { return kv.list(options || {}); }
  };
}
export function connectLambda() {}
