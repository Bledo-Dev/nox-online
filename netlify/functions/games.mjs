// Nox online: the list of games being hosted right now, and their join codes.
//
// The games themselves run on the players' own PCs. This only remembers
// "this code = this game, at this address" for a few minutes at a time.
//
//   POST /api/host    a host checks in (every 2 minutes while hosting)
//                     { name, game, players, max, port, ip?, url?, token?, code?, stop?, device? }
//                     (url: a host that can't let players in directly comes through
//                      Cloudflare's tunnel, wss://....trycloudflare.com)
//                     -> { code, token, ip, port }
//   GET  /api/games   the games checked in during the last 5 minutes
//   GET  /api/code?c=ABC123&device=...   one game, by its code
//
// A device that's timed out or banned (lib/standing.mjs) can't host or look up a game.
//
// Everything is kept in Netlify Blobs (store "games", one entry per code).

import { getStore } from "@netlify/blobs";
import { check } from "../lib/standing.mjs";

const STALE_MS = 5 * 60 * 1000;   // not heard from in 5 minutes: gone
const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const VERSION = 1;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f|]/g, "").slice(0, max);
const isIPv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split(".").every((n) => +n < 256);
const newCode = () => Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * 32)]).join("");
const newToken = () => Array.from({ length: 24 }, () => ALPHA[Math.floor(Math.random() * 32)]).join("");

// what people see of a game (never the host's token)
const pub = (g) => ({
  code: g.code, game: g.game, host: g.name, players: g.players, max: g.max,
  ip: g.ip, port: g.port, url: g.url || "", version: g.version,
});
const isTunnel = (s) => /^wss:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(s);
// timed out or banned: refused, with what to show the player
const refused = (st) => json({ error: st.message, blocked: true, until: st.until, left: st.left || 0 }, 403);

export default async (req, context) => {
  // strong: a game checking in must find the entry it made 2 minutes ago (the default,
  // "eventual", can answer with an older copy, and the game would get a new code each time)
  const store = getStore({ name: "games", consistency: "strong" });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (req.method === "POST" && path.endsWith("/host")) {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }

    // a host that stops: take its game off the list
    if (b.stop && b.code && b.token) {
      const old = await store.get(String(b.code), { type: "json" });
      if (old && old.token === b.token) await store.delete(String(b.code));
      return json({ ok: true });
    }

    // the address others reach it at: what its router said (UPnP), else where this request came from
    const url = isTunnel(String(b.url ?? "")) ? String(b.url) : "";
    const ip = url ? "" : isIPv4(String(b.ip ?? "")) ? String(b.ip) : isIPv4(context.ip ?? "") ? context.ip : "";
    const port = Number(b.port) | 0;
    if (!ip && !url) return json({ error: "Your internet address couldn't be found (IPv6 only?)." }, 400);
    if (port < 1 || port > 65535) return json({ error: "bad port" }, 400);

    // timed out or banned: no hosting
    if (b.device) {
      const st = await check(String(b.device).toLowerCase(), clean(b.name, 24), String(context.ip ?? ""));
      if (st.blocked) return refused(st);
    }
    // blocked in the admin panel (admin.mjs): this PC can't list games
    const from = String(context.ip ?? "");
    const admin = getStore({ name: "admin", consistency: "strong" });
    const blocked = (await admin.get("blocked", { type: "json" })) || { ips: [] };
    if (from && blocked.ips.some((x) => x.ip === from)) return json({ error: "This PC can't host Nox games." }, 403);
    // taken off the list in the admin panel: this hosting session stays off (a new one can list again)
    const removed = (await admin.get("removed", { type: "json" })) || {};
    if (b.token && removed[clean(b.token, 40)]) return json({ error: "This game was taken off the list." }, 410);

    let code = clean(b.code, 6).toUpperCase();
    let token = clean(b.token, 40);
    if (code) {   // checking in again: only the host that made it may change it
      const old = await store.get(code, { type: "json" });
      if (!old || old.token !== token) code = "";
    }
    if (!code) {   // a new game: a code no one else has
      for (let i = 0; i < 8 && !code; i++) {
        const c = newCode();
        if (!(await store.get(c))) code = c;
      }
      if (!code) return json({ error: "try again" }, 503);
      token = newToken();
      if (url) {   // one tunnel is one game: an older entry for it goes
        const { blobs } = await store.list();
        for (const { key } of blobs.slice(0, 200)) {
          const g = await store.get(key, { type: "json" });
          if (g && g.url === url) await store.delete(key);
        }
      }
    }
    const old = code ? await store.get(code, { type: "json" }) : null;
    const game = {
      code, token, ip, port, url, from, device: /^[0-9a-f]{32}$/.test(String(b.device || "")) ? String(b.device) : "",
      started: (old && old.started) || Date.now(),
      name: clean(b.name, 24) || "Someone",
      game: clean(b.game, 48) || "A Nox game",
      players: Math.max(0, Math.min(99, Number(b.players) | 0)),
      max: Math.max(1, Math.min(99, Number(b.max) | 0 || 16)),
      version: Number(b.version) | 0 || VERSION,
      updated: Date.now(),
    };
    await store.setJSON(code, game);
    return json({ code, token, ip, port, url });
  }

  if (req.method === "GET" && path.endsWith("/games")) {
    const { blobs } = await store.list();
    const now = Date.now(), list = [];
    for (const { key } of blobs.slice(0, 200)) {
      const g = await store.get(key, { type: "json" });
      if (!g) continue;
      if (now - g.updated > STALE_MS) { await store.delete(key); continue; }   // (tidy up as we go)
      list.push(pub(g));
    }
    list.sort((a, b) => b.players - a.players);
    return json({ games: list.slice(0, 50) });
  }

  if (req.method === "GET" && path.endsWith("/code")) {
    const device = String(url.searchParams.get("device") || "").toLowerCase();
    if (device) {
      const st = await check(device, String(url.searchParams.get("name") || ""), String(context.ip ?? ""));
      if (st.blocked) return refused(st);
    }
    const c = clean(url.searchParams.get("c"), 6).toUpperCase();
    const g = c ? await store.get(c, { type: "json" }) : null;
    if (!g || Date.now() - g.updated > STALE_MS) return json({ error: "No game is using that code right now." }, 404);
    return json(pub(g));
  }

  return json({ error: "not found" }, 404);
};

export const config = { path: ["/api/host", "/api/games", "/api/code"] };
