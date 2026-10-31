// Nox: where the website keeps things (a Cloudflare D1 database: one table of keys and values).
// Works like Netlify Blobs did, so the rest of the code didn't have to change:
//   const s = getStore({ name: "games" });
//   await s.get(key)  /  s.get(key, { type: "json" })  /  s.set(key, text)  /  s.setJSON(key, value)
//   await s.delete(key)  /  s.list({ prefix })  -> { blobs: [{ key }] }

let DB = null, ready = null;
export function useDb (db) { if (DB !== db) { DB = db; ready = null; } }

function init () {
  if (!DB) throw new Error("No database (the DB binding in wrangler.jsonc).");
  if (!ready) ready = DB.prepare("CREATE TABLE IF NOT EXISTS kv (store TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (store, k))").run()
    .catch((e) => { ready = null; throw e; });
  return ready;
}

export function getStore (o) {
  const name = typeof o === "string" ? o : o.name;
  const set = async (k, v) => {
    await init();
    await DB.prepare("INSERT INTO kv (store, k, v) VALUES (?1, ?2, ?3) ON CONFLICT(store, k) DO UPDATE SET v = excluded.v")
      .bind(name, String(k), String(v)).run();
  };
  return {
    async get (k, opt) {
      await init();
      const r = await DB.prepare("SELECT v FROM kv WHERE store = ?1 AND k = ?2").bind(name, String(k)).first();
      if (!r) return null;
      if (opt && opt.type === "json") { try { return JSON.parse(r.v); } catch { return null; } }
      return r.v;
    },
    set,
    setJSON: (k, v) => set(k, JSON.stringify(v)),
    async delete (k) {
      await init();
      await DB.prepare("DELETE FROM kv WHERE store = ?1 AND k = ?2").bind(name, String(k)).run();
    },
    async list (opt) {
      await init();
      const prefix = String((opt && opt.prefix) || "");
      const { results } = prefix
        ? await DB.prepare("SELECT k FROM kv WHERE store = ?1 AND substr(k, 1, ?2) = ?3 ORDER BY k").bind(name, prefix.length, prefix).all()
        : await DB.prepare("SELECT k FROM kv WHERE store = ?1 ORDER BY k").bind(name).all();
      return { blobs: results.map((r) => ({ key: r.k })) };
    },
  };
}

// now and then: this hour's-limit counters older than two days go ("<key>-<hour>": the hour has 6 digits)
export async function tidy () {
  await init();
  const hour = Math.floor(Date.now() / 3600000);
  await DB.prepare("DELETE FROM kv WHERE store = 'limits' AND k GLOB '*-[0-9][0-9][0-9][0-9][0-9][0-9]' AND CAST(substr(k, -6) AS INTEGER) < ?1")
    .bind(hour - 48).run();
}
