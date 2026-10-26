// Nox: where each device stands (strikes, time-outs, bans). Used by standing.mjs,
// games.mjs, report.mjs and admin.mjs. Kept in Netlify Blobs:
//   store "standing", one entry per device ID:
//     { strikes, until, banned, reason, warn, log: [...], name, ip, first, last }
//   store "admin": "trusted" (the owner's devices: never touched), "recentBans" and
//     "flags" (possible ban-dodgers, for the owner to look at: never acted on alone)
//
// The ladder, one step per strike (a strike: the owner confirmed a report about them,
// or marked a report they made as false):
//   1 a warning   2 one hour   3 one day   4 one week   5 banned for good

import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
export const LADDER = [0, 0, HOUR, DAY, 7 * DAY];   // (by strike count; 5 and up: banned)
export const NOT_TRUSTED = "You are not trusted to play Nox right now. Try again later.";
export const BANNED = "You are not trusted to play Nox anymore.";

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? "");
export const hashIp = (ip) => createHash("sha256").update((env("NOX_SALT") || env("ADMIN_PASS") || "nox") + "|" + ip).digest("hex").slice(0, 32);
export const isDevice = (s) => /^[0-9a-f]{32}$/.test(s) && !/^0+$/.test(s);   // (all zeros: no ID was set)

const stores = () => ({
  standing: getStore({ name: "standing", consistency: "strong" }),
  admin: getStore({ name: "admin", consistency: "strong" }),
});

export async function isTrusted (device) {
  const t = (await stores().admin.get("trusted", { type: "json" })) || { devices: [] };
  return t.devices.some((d) => d.device === device);
}

const blank = (device) => ({ device, strikes: 0, until: 0, banned: false, reason: "", warn: "", log: [], name: "", ip: "", first: 0, last: 0 });
export async function getStanding (device) {
  return (await stores().standing.get(device, { type: "json" })) || blank(device);
}

// "Ana_77" and "ana 77", "xXAnaXx" and "ana": maybe the same person
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function lev (a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function similarNames (x, y) {
  const a = norm(x), b = norm(y);
  if (a.length < 3 || b.length < 3) return a === b && a.length > 0;
  return a === b || a.includes(b) || b.includes(a) || lev(a, b) <= 2;
}

// a strike: the next step on the ladder
export async function strike (device, reason, why) {
  const { standing, admin } = stores();
  if (await isTrusted(device)) return { skipped: "trusted" };
  const s = await getStanding(device);
  const now = Date.now();
  s.strikes += 1;
  s.reason = reason;
  if (s.strikes >= 5) { s.banned = true; s.until = 0; }
  else if (s.strikes === 1) s.warn = reason;
  else s.until = now + LADDER[s.strikes];
  s.log.push({ when: now, what: "strike", reason, why });
  s.log = s.log.slice(-30);
  await standing.setJSON(device, s);
  if (s.strikes >= 2) await rememberBan(admin, s, now);
  return { strikes: s.strikes, until: s.until, banned: s.banned };
}

export async function ban (device, reason) {
  const { standing, admin } = stores();
  if (await isTrusted(device)) return { skipped: "trusted" };
  const s = await getStanding(device);
  const now = Date.now();
  s.banned = true; s.until = 0; s.reason = reason || "Banned by a Nox moderator";
  s.strikes = Math.max(s.strikes, 5);
  s.log.push({ when: now, what: "ban", reason: s.reason });
  s.log = s.log.slice(-30);
  await standing.setJSON(device, s);
  await rememberBan(admin, s, now);
  return { banned: true };
}

// unban: the time-out or ban ends, and the strikes start again from nothing
export async function unban (device) {
  const s = await getStanding(device);
  s.banned = false; s.until = 0; s.strikes = 0; s.warn = ""; s.reason = "";
  s.log.push({ when: Date.now(), what: "unban" });
  s.log = s.log.slice(-30);
  await stores().standing.setJSON(device, s);
  const { admin } = stores();
  const rb = (await admin.get("recentBans", { type: "json" })) || [];
  await admin.setJSON("recentBans", rb.filter((x) => x.device !== device));
  return { ok: true };
}

async function rememberBan (admin, s, now) {   // (for spotting someone coming back on a new device)
  const rb = ((await admin.get("recentBans", { type: "json" })) || []).filter((x) => now - x.when < 7 * DAY && x.device !== s.device);
  rb.push({ device: s.device, name: s.name, ip: s.ip, when: now });
  await admin.setJSON("recentBans", rb.slice(-200));
}

// a device asking "can I play?" (when the app starts, before joining, when hosting).
// Also remembers its name and (scrambled) address, and notes possible ban-dodgers.
export async function check (device, name, ip, showWarning = false) {
  const { standing, admin } = stores();
  if (!isDevice(device)) return { ok: true };
  if (await isTrusted(device)) return { ok: true };
  const s = await getStanding(device);
  const now = Date.now();
  const isNew = !s.first;
  let dirty = false;
  if (isNew) { s.first = now; dirty = true; }
  const ipH = ip ? hashIp(ip) : "";
  name = String(name || "").slice(0, 40);
  if ((ipH && s.ip !== ipH) || (name && s.name !== name) || now - s.last > 10 * 60 * 1000) {
    if (ipH) s.ip = ipH;
    if (name) s.name = name;
    s.last = now;
    dirty = true;
  }
  // a device first seen in the last day, from the same address as someone timed out or
  // banned in the last week, with a similar name: a clue for the owner (nothing happens to them)
  if (now - s.first < DAY && ipH && name && !s.banned && !(s.until > now)) {
    const rb = (await admin.get("recentBans", { type: "json" })) || [];
    const hit = rb.find((x) => x.device !== device && x.ip === ipH && now - x.when < 7 * DAY && similarNames(x.name, name));
    if (hit) {
      const flags = (await admin.get("flags", { type: "json" })) || [];
      if (!flags.some((f) => f.device === device)) {
        flags.push({ device, name, like: hit.device, likeName: hit.name, when: now });
        await admin.setJSON("flags", flags.slice(-100));
      }
    }
  }
  let out = { ok: true };
  if (s.banned) out = { blocked: true, until: 0, message: BANNED, reason: s.reason };
  else if (s.until > now) out = { blocked: true, until: s.until, left: s.until - now, message: NOT_TRUSTED, reason: s.reason };
  else if (s.warn && showWarning) {   // (shown once, by the app: /api/standing)
    out = { ok: true, warning: s.warn };
    s.warn = "";
    dirty = true;
  }
  if (dirty) await standing.setJSON(device, s);
  return out;
}
