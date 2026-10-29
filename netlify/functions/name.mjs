// Nox: usernames (the Nox app's Settings, and when it starts). A username is picked once
// and can't be changed (lib/names.mjs).
//
//   POST /api/name  { device, key?, name }   name "": just say what this device's username is
//   -> { ok, name, key? }   (key: only the first time; the app keeps it in nox_name.txt)
//   -> { error, name? }     (409: taken, not allowed, or this device already has one (name);
//                            400: not a valid username; 403: the name key doesn't match)

import { claimName } from "../lib/names.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const r = await claimName(b.device, b.key, b.name, String(context.ip ?? ""));
  return r.error ? json(r.name ? { error: r.error, name: r.name } : { error: r.error }, r.status) : json(r);
};

export const config = { path: "/api/name" };
