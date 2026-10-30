// Nox: proof that a player's username is theirs, for the host of the game they join.
//
//   POST /api/ticket  { device, key, host }                 -> { ticket }   (the joiner asks; good for 10 minutes)
//   POST /api/ticket  { check: ticket, name, device, host } -> { ok }       (the host asks: is this ticket this
//                                                                            player's, for me? A ticket works once.)
// host: the host's device ID (it says it when you join). The joiner's device and name key
// (nox_name.txt) say who's asking (lib/names.mjs), so a hacked copy of Nox can't pretend
// to be someone else: the host sends players without a good ticket away.
//
// Netlify Blobs, store "tickets":  t-<ticket>  { name, device, host, until }
// A ticket starts with the hour it was made (8 hex digits), so old ones can be cleared
// by their names alone.

import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { whoIs } from "../lib/names.mjs";
import { check, hashIp, isDevice } from "../lib/standing.mjs";
import { allow } from "../lib/limits.mjs";

const LIFE = 10 * 60 * 1000;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const store = () => getStore({ name: "tickets", consistency: "strong" });
const hourHex = (h) => (h >>> 0).toString(16).padStart(8, "0");

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const host = String(b.host || "").toLowerCase();
  if (!isDevice(host)) return json({ error: "bad request" }, 400);

  if ("check" in b) {   // the host checks a player
    const t = String(b.check || "");
    if (!/^[0-9a-f]{48}$/.test(t)) return json({ ok: false });
    if (!(await allow([`tk-h-${host}-${hashIp(String(context.ip ?? ""))}`], 600))) return json({ error: "Too many checks." }, 429);
    const s = store(), got = await s.get(`t-${t}`, { type: "json" });
    if (!got) return json({ ok: false });
    await s.delete(`t-${t}`);   // (once)
    const ok = got.until > Date.now() && got.host === host && got.device === String(b.device || "").toLowerCase() &&
               got.name.toLowerCase() === String(b.name || "").toLowerCase();
    return json({ ok });
  }

  const who = await whoIs(b.device, b.key);   // a player asks for one
  if (who.error) return json({ error: who.error }, who.status);
  const st = await check(who.device, who.name, String(context.ip ?? ""));
  if (st.blocked) return json({ error: st.message }, 403);
  if (!(await allow([`tk-d-${who.device}`], 60))) return json({ error: "Too many games joined for now. Try again later." }, 429);
  const hour = Math.floor(Date.now() / 3600000), s = store();
  const ticket = hourHex(hour) + randomBytes(20).toString("hex");
  await s.setJSON(`t-${ticket}`, { name: who.name, device: who.device, host, until: Date.now() + LIFE });
  if (Math.random() < 0.05) {   // (now and then: tickets from a few hours ago that nobody checked go, unread)
    for (let h = hour - 6; h <= hour - 2; h++) {
      const { blobs } = await s.list({ prefix: `t-${hourHex(h)}` });
      for (const { key } of blobs.slice(0, 200)) await s.delete(key);
    }
  }
  return json({ ticket });
};

export const config = { path: "/api/ticket" };
