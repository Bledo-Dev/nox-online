// Nox admin: take games off the list, and block PCs from listing games.
//
// Signing in takes the username and password, then a 6-digit code emailed to the admin.
// Everything secret is in Netlify's environment variables (never in this code):
//   ADMIN_USER, ADMIN_PASS      the one login
//   ADMIN_EMAIL                 where the code goes
//   RESEND_API_KEY              the email service (resend.com, free plan)
//
//   POST /api/admin/login    { user, pass }          -> { pending }   (and the email is sent)
//   POST /api/admin/verify   { pending, code }       -> { token }     (good for 1 hour)
//   then with  Authorization: Bearer <token>
//   GET  /api/admin/games                            every listed game, with where it came from
//   POST /api/admin/delete   { code }                take a game off the list
//   POST /api/admin/clear                            take every game off the list
//   POST /api/admin/block    { code, note? }         off the list, and its PC can't list games again
//   GET  /api/admin/blocked                          the blocked PCs
//   POST /api/admin/unblock  { ip }
//   GET  /api/admin/reports                          reports (waiting ones first), with how many people reported each player
//   POST /api/admin/decide   { id, action }          action: "confirm" (the reported player gets a strike),
//                                                    "dismiss" (nothing happens), "false" (the reporter gets a strike)
//   GET  /api/admin/shot?id=                         a report's screenshot (a PNG)
//   GET  /api/admin/standing                         devices with strikes, time-outs and bans
//   POST /api/admin/ban      { device, reason? }     banned for good
//   POST /api/admin/unban    { device }              the time-out or ban ends, strikes back to 0
//   GET  /api/admin/flags                            possible ban-dodgers (only shown: nothing happens to them)
//   POST /api/admin/unflag   { device }
//   GET  /api/admin/trusted                          the owner's own devices (never scored, timed out or banned)
//   POST /api/admin/trust    { device, note? }
//   POST /api/admin/untrust  { device }
//   POST /api/admin/logout

import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { strike, ban, unban, getStanding, isDevice } from "../lib/standing.mjs";

const MAX_FAILS = 5;                 // wrong logins (or codes) before a lock
const LOCK_MS = 15 * 60 * 1000;      // how long the lock lasts
const CODE_MS = 10 * 60 * 1000;      // how long an emailed code works
const SESSION_MS = 60 * 60 * 1000;   // how long a sign-in lasts

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? "");
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
// a game taken off the list stays off: its hosting session (token) is refused when it checks in
async function remember (admin, tokens) {
  const removed = (await admin.get("removed", { type: "json" })) || {};
  const now = Date.now();
  for (const t of Object.keys(removed)) if (now - removed[t] > 24 * 60 * 60 * 1000) delete removed[t];   // (a day is plenty)
  for (const t of tokens) if (t) removed[t] = now;
  await admin.setJSON("removed", removed);
}

const same = (a, b) => {   // (compares without giving away how much matched)
  const x = Buffer.from(hash(a)), y = Buffer.from(hash(b));
  return timingSafeEqual(x, y);
};

async function sendCode (code) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env("RESEND_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "Nox <onboarding@resend.dev>",
      to: [env("ADMIN_EMAIL")],
      subject: `Nox admin code: ${code}`,
      text: `Your Nox admin sign-in code is ${code}\n\nIt works once, for 10 minutes.\nIf you didn't just sign in, someone has your password: change ADMIN_PASS in Netlify.`,
    }),
  });
  return r.ok;
}

export default async (req, context) => {
  const admin = getStore({ name: "admin", consistency: "strong" });
  const games = getStore({ name: "games", consistency: "strong" });
  const url = new URL(req.url);
  const what = url.pathname.replace(/\/+$/, "").split("/").pop();
  let b = {};
  if (req.method === "POST") { try { b = await req.json(); } catch { b = {}; } }

  if (!env("ADMIN_USER") || !env("ADMIN_PASS") || !env("ADMIN_EMAIL") || !env("RESEND_API_KEY"))
    return json({ error: "The admin panel isn't set up: add the environment variables in Netlify." }, 503);

  // ---- signing in (with a lock after too many wrong tries) ----
  if (what === "login" || what === "verify") {
    const lock = (await admin.get("lock", { type: "json" })) || { fails: 0, until: 0 };
    if (lock.until > Date.now()) return json({ error: "Too many wrong tries. Locked for a while." }, 429);
    const fail = async () => {
      lock.fails += 1;
      if (lock.fails >= MAX_FAILS) { lock.fails = 0; lock.until = Date.now() + LOCK_MS; }
      await admin.setJSON("lock", lock);
      return json({ error: lock.until > Date.now() ? "Too many wrong tries. Locked for 15 minutes." : "That's not right." }, 401);
    };

    if (what === "login" && req.method === "POST") {
      if (!same(b.user, env("ADMIN_USER")) || !same(b.pass, env("ADMIN_PASS"))) return fail();
      const code = String(randomInt(0, 1000000)).padStart(6, "0");
      const pending = randomBytes(16).toString("hex");
      await admin.setJSON("pending", { id: pending, code: hash(code), expires: Date.now() + CODE_MS });
      if (!(await sendCode(code))) return json({ error: "Couldn't send the email (check RESEND_API_KEY and ADMIN_EMAIL)." }, 502);
      return json({ pending });
    }
    if (what === "verify" && req.method === "POST") {
      const p = await admin.get("pending", { type: "json" });
      if (!p || p.expires < Date.now() || !same(b.pending, p.id)) return json({ error: "That code ran out. Sign in again." }, 401);
      const c = String(b.code ?? "").trim();
      if (/^\d{6}$/.test(c) && same(hash(c), p.code)) {
        await admin.delete("pending");   // (a code works once)
        await admin.setJSON("lock", { fails: 0, until: 0 });
        const token = randomBytes(32).toString("hex");
        await admin.setJSON(`session-${hash(token)}`, { expires: Date.now() + SESSION_MS });
        return json({ token });
      }
      return fail();
    }
    return json({ error: "not found" }, 404);
  }

  // ---- everything else needs a sign-in ----
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const session = token ? await admin.get(`session-${hash(token)}`, { type: "json" }) : null;
  if (!session || session.expires < Date.now()) return json({ error: "Signed out. Sign in again." }, 401);

  if (what === "logout") { await admin.delete(`session-${hash(token)}`); return json({ ok: true }); }

  if (what === "games" && req.method === "GET") {
    const { blobs } = await games.list();
    const list = [];
    for (const { key } of blobs.slice(0, 300)) {
      const g = await games.get(key, { type: "json" });
      if (g) list.push({ code: g.code, game: g.game, host: g.name, players: g.players, max: g.max,
                         url: g.url || "", ip: g.ip, port: g.port, from: g.from || "", started: g.started || 0, updated: g.updated });
    }
    list.sort((a, b) => b.updated - a.updated);
    return json({ games: list });
  }

  if (what === "delete" && req.method === "POST") {
    const code = String(b.code || "").toUpperCase();
    const g = await games.get(code, { type: "json" });
    if (g) await remember(admin, [g.token]);
    await games.delete(code);
    return json({ ok: true });
  }

  if (what === "clear" && req.method === "POST") {
    const { blobs } = await games.list();
    const tokens = [];
    for (const { key } of blobs) {
      const g = await games.get(key, { type: "json" });
      if (g) tokens.push(g.token);
    }
    await remember(admin, tokens);
    for (const { key } of blobs) await games.delete(key);
    return json({ ok: true, removed: blobs.length });
  }

  if (what === "block" && req.method === "POST") {
    const g = await games.get(String(b.code || "").toUpperCase(), { type: "json" });
    if (!g) return json({ error: "That game is already gone." }, 404);
    if (!g.from) return json({ error: "This game didn't say where it came from (listed before blocking existed). Delete it instead." }, 400);
    const blocked = (await admin.get("blocked", { type: "json" })) || { ips: [] };
    if (!blocked.ips.some((x) => x.ip === g.from))
      blocked.ips.push({ ip: g.from, host: g.name, game: g.game, note: String(b.note || "").slice(0, 200), when: Date.now() });
    await admin.setJSON("blocked", blocked);
    const { blobs } = await games.list();   // (every game from that PC goes)
    for (const { key } of blobs) {
      const x = await games.get(key, { type: "json" });
      if (x && x.from === g.from) await games.delete(key);
    }
    return json({ ok: true });
  }

  // ---- reports ----
  if (what === "reports" && req.method === "GET") {
    const store = getStore({ name: "reports", consistency: "strong" });
    const { blobs } = await store.list();
    const keys = blobs.map((x) => x.key).sort().reverse().slice(0, 300);   // (newest first: keys start with the time)
    const list = [];
    for (const key of keys) {
      const r = await store.get(key, { type: "json" });
      if (r) list.push(r);
    }
    const people = {};   // per reported device: different reporters (devices and addresses both counted once)
    for (const r of list) {
      const p = (people[r.target] = people[r.target] || { dev: new Set(), ip: new Set() });
      p.dev.add(r.reporter);
      p.ip.add(r.reporterIp);
    }
    const strikes = {};   // (each reported player's strikes so far)
    for (const r of list) if (!(r.target in strikes)) strikes[r.target] = (await getStanding(r.target)).strikes;
    const out = list.map((r) => ({
      id: r.id, when: r.when, status: r.status, reason: r.reason, note: r.note || "", game: r.game, chat: r.chat, owner: !!r.owner,
      shot: !!r.shot, target: r.target, targetName: r.targetName, reporter: r.reporter, reporterName: r.reporterName,
      reporters: Math.min(people[r.target].dev.size, people[r.target].ip.size), strikes: strikes[r.target] || 0,
    }));
    out.sort((a, b) => ((b.status === "pending") - (a.status === "pending")) || (b.when - a.when));   // (waiting ones first, then newest)
    return json({ reports: out });
  }

  if (what === "decide" && req.method === "POST") {
    const store = getStore({ name: "reports", consistency: "strong" });
    const r = await store.get(String(b.id || ""), { type: "json" });
    if (!r) return json({ error: "That report is gone." }, 404);
    if (!["confirm", "dismiss", "false"].includes(b.action)) return json({ error: "bad request" }, 400);
    if (r.status !== "pending") return json({ error: "That report was already decided." }, 409);   // (no double strikes)
    let result = {};
    if (b.action === "confirm") result = await strike(r.target, r.reason, `report ${r.id}`);
    if (b.action === "false") result = await strike(r.reporter, "False report", `report ${r.id}`);
    r.status = b.action === "confirm" ? "confirmed" : b.action === "false" ? "false" : "dismissed";
    r.decided = Date.now();
    await store.setJSON(r.id, r);
    return json({ ok: true, result });
  }

  if (what === "shot" && req.method === "GET") {
    const b64 = await getStore({ name: "shots", consistency: "strong" }).get(String(url.searchParams.get("id") || ""));
    if (!b64) return json({ error: "No screenshot." }, 404);
    return new Response(Buffer.from(String(b64), "base64"), {
      headers: { "content-type": "image/png", "cache-control": "private, max-age=3600", "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" },
    });
  }

  // ---- strikes, time-outs and bans ----
  if (what === "standing" && req.method === "GET") {
    const store = getStore({ name: "standing", consistency: "strong" });
    const { blobs } = await store.list();
    const now = Date.now(), list = [];
    for (const { key } of blobs.slice(0, 500)) {
      const x = await store.get(key, { type: "json" });
      if (x && (x.strikes > 0 || x.banned))
        list.push({ device: x.device, name: x.name, strikes: x.strikes, banned: !!x.banned, until: x.until > now ? x.until : 0, reason: x.reason || "", last: x.last || 0 });
    }
    list.sort((a, b) => (b.banned - a.banned) || (b.until - a.until) || (b.strikes - a.strikes));
    return json({ devices: list });
  }

  if (what === "ban" && req.method === "POST") {
    const device = String(b.device || "").trim().toLowerCase();
    if (!isDevice(device)) return json({ error: "That's not a device ID." }, 400);
    const r = await ban(device, String(b.reason || "").slice(0, 120));
    if (r.skipped) return json({ error: "That's one of your trusted devices." }, 400);
    return json({ ok: true });
  }

  if (what === "unban" && req.method === "POST") {
    const device = String(b.device || "").trim().toLowerCase();
    if (!isDevice(device)) return json({ error: "That's not a device ID." }, 400);
    return json(await unban(device));
  }

  if (what === "flags" && req.method === "GET") {
    return json({ flags: (await admin.get("flags", { type: "json" })) || [] });
  }

  if (what === "unflag" && req.method === "POST") {
    const flags = (await admin.get("flags", { type: "json" })) || [];
    await admin.setJSON("flags", flags.filter((f) => f.device !== String(b.device)));
    return json({ ok: true });
  }

  // ---- the owner's own devices ----
  if (what === "trusted" && req.method === "GET") {
    return json((await admin.get("trusted", { type: "json" })) || { devices: [] });
  }

  if (what === "trust" && req.method === "POST") {
    const device = String(b.device || "").trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(device)) return json({ error: "A device ID is 32 letters and numbers (Settings in the Nox app shows it)." }, 400);
    const t = (await admin.get("trusted", { type: "json" })) || { devices: [] };
    if (!t.devices.some((d) => d.device === device)) t.devices.push({ device, note: String(b.note || "").slice(0, 80), when: Date.now() });
    await admin.setJSON("trusted", t);
    return json({ ok: true });
  }

  if (what === "untrust" && req.method === "POST") {
    const t = (await admin.get("trusted", { type: "json" })) || { devices: [] };
    t.devices = t.devices.filter((d) => d.device !== String(b.device));
    await admin.setJSON("trusted", t);
    return json({ ok: true });
  }

  if (what === "blocked" && req.method === "GET") {
    return json((await admin.get("blocked", { type: "json" })) || { ips: [] });
  }

  if (what === "unblock" && req.method === "POST") {
    const blocked = (await admin.get("blocked", { type: "json" })) || { ips: [] };
    blocked.ips = blocked.ips.filter((x) => x.ip !== String(b.ip));
    await admin.setJSON("blocked", blocked);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
};

export const config = { path: "/api/admin/*" };
