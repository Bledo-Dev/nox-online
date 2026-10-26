// Nox: a player reports another (the Report button in a game's Players list).
//
//   POST /api/report  { reporter, reporterName, target, targetName, reason, note?, game, chat: [...], shot?, version }
//   (note: what happened, in the reporter's words (for "Other"); shot: a screenshot Nox
//    took itself when Report was pressed, a PNG as base64. Nobody can attach a file.)
//
// Reports wait in the admin panel (admin.mjs) to be confirmed or dismissed.
// Devices are Nox's random device IDs (32 hex characters). Internet addresses are
// kept only scrambled (hashed), to tell reporters apart.
// Limits, so nobody can flood it: 8 reports an hour from one device or one address,
// and one report a day from the same person about the same player.

import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { check, hashIp, isDevice } from "../lib/standing.mjs";

const REASONS = ["Bad chat", "Cheating", "Inappropriate", "Bullying", "Scamming", "Spamming", "Pretending to be someone", "Other"];
const SHOT_MAX = 900 * 1024;   // (base64 characters: a picture of about 650 KB at most)
const PER_HOUR = 8;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").slice(0, max);

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const reporter = String(b.reporter ?? ""), target = String(b.target ?? "");
  const reason = REASONS.includes(b.reason) ? b.reason : "";
  if (!isDevice(reporter) || !isDevice(target) || !reason) return json({ error: "bad request" }, 400);
  if (reporter === target) return json({ error: "You can't report yourself." }, 400);

  const note = clean(b.note, 300).trim();
  if (reason === "Other" && !note) return json({ error: "Say what happened." }, 400);
  const st = await check(reporter, clean(b.reporterName, 40), String(context.ip ?? ""));
  if (st.blocked) return json({ error: st.message }, 403);   // (timed out or banned: no reporting either)

  const rl = getStore({ name: "limits", consistency: "strong" });
  const ipH = hashIp(String(context.ip ?? ""));
  const hour = Math.floor(Date.now() / 3600000), day = Math.floor(Date.now() / 86400000);
  for (const who of [`d-${reporter}`, `i-${ipH}`]) {   // (8 an hour)
    const c = (await rl.get(`${who}-${hour}`, { type: "json" })) || { n: 0 };
    if (c.n >= PER_HOUR) return json({ error: "Too many reports for now. Try again later." }, 429);
  }
  const pairKey = `p-${reporter}-${target}-${day}`;
  if (await rl.get(pairKey)) return json({ error: "You already reported this player today." }, 429);
  for (const who of [`d-${reporter}`, `i-${ipH}`]) {
    const c = (await rl.get(`${who}-${hour}`, { type: "json" })) || { n: 0 };
    await rl.setJSON(`${who}-${hour}`, { n: c.n + 1 });
  }
  await rl.setJSON(pairKey, { at: Date.now() });

  const trusted = (await getStore({ name: "admin", consistency: "strong" }).get("trusted", { type: "json" })) || { devices: [] };
  const chat = Array.isArray(b.chat) ? b.chat.slice(-15).map((l) => clean(l, 240)) : [];
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  // the screenshot: only a real PNG (by its first bytes), kept apart from the report
  const shot = typeof b.shot === "string" && b.shot.length <= SHOT_MAX && /^iVBORw0KGgo[A-Za-z0-9+/=]*$/.test(b.shot) ? b.shot : "";
  if (shot) await getStore({ name: "shots", consistency: "strong" }).set(id, shot);
  await getStore({ name: "reports", consistency: "strong" }).setJSON(id, {
    id, when: Date.now(), status: "pending",
    reporter, reporterName: clean(b.reporterName, 40), reporterIp: ipH,
    target, targetName: clean(b.targetName, 40), reason, note, game: clean(b.game, 80), chat, shot: !!shot,
    owner: trusted.devices.some((d) => d.device === target),   // (reports about the owner's own devices: a note only)
  });
  return json({ ok: true });
};

export const config = { path: "/api/report" };
