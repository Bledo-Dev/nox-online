// Nox: "can this device play right now?" The Nox app asks when it starts, before
// joining a game, and every few minutes while playing.
//
//   GET /api/standing?device=<32 hex>&name=<player name>
//   -> { ok: true }  or  { ok: true, warning }  or  { blocked: true, until, left, message, reason }
//      (until 0 with blocked: banned for good)

import { check } from "../lib/standing.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req, context) => {
  const url = new URL(req.url);
  const device = String(url.searchParams.get("device") || "").toLowerCase();
  const name = String(url.searchParams.get("name") || "");
  return json(await check(device, name, String(context.ip ?? ""), true));
};

export const config = { path: "/api/standing" };
