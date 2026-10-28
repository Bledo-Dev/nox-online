// Nox: claiming a player name (the Nox app's Settings, and when it starts).
//
//   POST /api/name  { device, key?, name }
//   -> { ok, name, key? }   (key: only the first time; the app keeps it in nox_name.txt)
//   -> { error }            (409: the name is someone else's; 400: not a valid name)

import { claimName } from "../lib/names.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const r = await claimName(b.device, b.key, b.name, String(context.ip ?? ""));
  return r.error ? json({ error: r.error }, r.status) : json(r);
};

export const config = { path: "/api/name" };
