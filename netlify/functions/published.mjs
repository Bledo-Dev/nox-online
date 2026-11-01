// Nox: published games. The admin uploads a game (a .noxgame file, from Studio's File > Save to File)
// in the admin panel; it's kept here until the admin deletes it, and anyone can play it from the Nox app.
//
//   GET /api/published                  -> { games: [{ id, name, desc, creator, size, parts, when }] }
//   GET /api/published?id=...&part=N    the file's part N (base64 text; the parts joined are the .noxgame)
//
// Store "published":  "list" [ the games ]   "c-<id>-<N>" a part (base64)   "up-<id>" an upload in progress
// (uploading and deleting: admin.mjs)

import { getStore } from "../lib/store.mjs";

export const PART = 512 * 1024;            // a part of the file (before base64)
export const MAX_SIZE = 100 * 1024 * 1024;  // the biggest game file
export const isId = (s) => /^[0-9a-f]{12}$/.test(String(s ?? ""));

export default async (req) => {
  const store = getStore({ name: "published", consistency: "strong" });
  const url = new URL(req.url);
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  const id = url.searchParams.get("id");
  if (id !== null) {
    const part = Number(url.searchParams.get("part"));
    const data = isId(id) && Number.isInteger(part) && part >= 0 ? await store.get(`c-${id}-${part}`) : null;
    if (data === null) return new Response("not found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    // (a game's id is new with every upload, so a part never changes)
    return new Response(data, { headers: { "content-type": "text/plain", "cache-control": "public, max-age=86400" } });
  }
  const list = (await store.get("list", { type: "json" })) || [];
  return new Response(JSON.stringify({ games: list }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};
