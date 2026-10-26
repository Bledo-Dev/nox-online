// Nox: a player reports another (the Report button in a game's Players list).
//
//   POST /api/report  { reporter, reporterName, target, targetName, reason, game, chat: [...], version }
//
// Reports wait in the admin panel (admin.mjs) to be confirmed or dismissed.
// Devices are Nox's random device IDs (32 hex characters). Internet addresses are
// kept only scrambled (hashed), to tell reporters apart.
// Limits, so nobody can flood it: 8 reports an hour from one device or one address,
// and one report a day from the same person about the same player.

import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";

const REASONS = ["Bad chat", "Cheating", "Inappropriate"];
const PER_HOUR = 8;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").slice(0, max);
const isDevice = (s) => /^[0-9a-f]{32}$/.test(s) && !/^0+$/.test(s);   // (all zeros: no ID was set)
const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? "");
const hashIp = (ip) => createHash("sha256").update((env("NOX_SALT") || env("ADMIN_PASS") || "nox") + "|" + ip).digest("hex").slice(0, 32);

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const reporter = String(b.reporter ?? ""), target = String(b.target ?? "");
  const reason = REASONS.includes(b.reason) ? b.reason : "";
  if (!isDevice(reporter) || !isDevice(target) || !reason) return json({ error: "bad request" }, 400);
  if (reporter === target) return json({ error: "You can't report yourself." }, 400);

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
  await getStore({ name: "reports", consistency: "strong" }).setJSON(id, {
    id, when: Date.now(), status: "pending",
    reporter, reporterName: clean(b.reporterName, 40), reporterIp: ipH,
    target, targetName: clean(b.targetName, 40), reason, game: clean(b.game, 80), chat,
    owner: trusted.devices.some((d) => d.device === target),   // (reports about the owner's own devices: a note only)
  });
  return json({ ok: true });
};

export const config = { path: "/api/report" };
