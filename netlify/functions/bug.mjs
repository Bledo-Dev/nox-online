// Nox: bug reports (Report a bug in the Nox app's Settings, or the form on /bugs.html).
//
//   POST /api/bug   { kind, text, log?, where?, version?, device? }  -> { ok, num }
//   GET  /api/bugs                                                  -> { bugs: [...] }   (only the ones the admin approved)
//
// Anonymous: no username, no device ID and no internet address is kept with a report.
// (device and the address are used only for this hour's limit, then forgotten.)
// Reports wait in the admin panel; nothing shows on /bugs.html until the admin approves it.
// Paths like C:\Users\Sam\... and emails and internet addresses are blanked out before saving.
//
// Netlify Blobs, store "bugs":  <id> { id, num, when, kind, text, log, where, version, shown, fixed }
//                               "counter" { n }   "public" [ ...approved, newest first ]

import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { hashIp, isDevice, getStanding } from "../lib/standing.mjs";
import { allow } from "../lib/limits.mjs";

export const KINDS = ["Crash", "Multiplayer", "Graphics", "Saves", "Controls", "Studio", "Website", "Other"];
const PER_HOUR = 5, ALL_PER_HOUR = 80;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, max);

// blanks out what could say who someone is
export const scrub = (s) => String(s)
  .replace(/([A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/\r\n"'<>]+/gi, "$1<you>")
  .replace(/(\/(?:home|Users)\/)[^\/\s"'<>]+/g, "$1<you>")
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
  .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<address>")
  .replace(/\b[0-9a-f]{32,}\b/gi, "<id>");

export default async (req, context) => {
  const store = getStore({ name: "bugs", consistency: "strong" });
  if (req.method === "GET") {
    const list = (await store.get("public", { type: "json" })) || [];
    return json({ bugs: list });
  }
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const kind = KINDS.includes(b.kind) ? b.kind : "";
  const text = scrub(clean(b.text, 400).replace(/\s+/g, " ").trim());
  if (!kind) return json({ error: "Pick what kind of bug it is." }, 400);
  if (text.length < 5) return json({ error: "Say what happened." }, 400);
  const device = String(b.device ?? "").toLowerCase();
  if (device && !isDevice(device)) return json({ error: "bad request" }, 400);

  if (device) {   // (timed out or banned: no reports either)
    const s = await getStanding(device);
    if (s.banned || s.until > Date.now()) return json({ error: "You can't send reports right now." }, 403);
  }
  const keys = [`bug-i-${hashIp(String(context.ip ?? ""))}`];
  if (device) keys.push(`bug-d-${device}`);
  if (!(await allow(keys, PER_HOUR))) return json({ error: "Too many reports for now. Try again in an hour." }, 429);
  if (!(await allow(["bug-all"], ALL_PER_HOUR))) return json({ error: "Lots of reports right now. Try again later." }, 429);

  const c = (await store.get("counter", { type: "json" })) || { n: 0 };
  const num = c.n + 1;
  await store.setJSON("counter", { n: num });
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  await store.setJSON(id, {
    id, num, when: Date.now(), kind, text,
    log: scrub(clean(b.log, 6000)),
    where: clean(b.where, 30), version: clean(b.version, 20),
    shown: false, fixed: false,
  });
  return json({ ok: true, num });
};

export const config = { path: ["/api/bug", "/api/bugs"] };
