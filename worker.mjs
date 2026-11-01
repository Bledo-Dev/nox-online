// Nox online, on Cloudflare Pages: the pages in public/ are served as they are (free, no limit);
// only /api/... runs this (through functions/api/[[path]].js), which hands it to its function in netlify/functions.
// (The folder is still called "netlify": that's where the site first ran.)

import games from "./netlify/functions/games.mjs";
import friends from "./netlify/functions/friends.mjs";
import ticket from "./netlify/functions/ticket.mjs";
import bug from "./netlify/functions/bug.mjs";
import admin from "./netlify/functions/admin.mjs";
import report from "./netlify/functions/report.mjs";
import name from "./netlify/functions/name.mjs";
import standing from "./netlify/functions/standing.mjs";
import published from "./netlify/functions/published.mjs";
import { useDb, tidy } from "./netlify/lib/store.mjs";

const ROUTES = {
  "/api/host": games, "/api/games": games, "/api/code": games, "/api/thumb": games,
  "/api/friends": friends, "/api/ticket": ticket, "/api/bug": bug, "/api/bugs": bug,
  "/api/report": report, "/api/name": name, "/api/standing": standing, "/api/published": published,
};

const notFound = () => new Response(JSON.stringify({ error: "not found" }), {
  status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export default {
  async fetch (req, env, ctx) {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (!path.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(req) : notFound();
    const fn = path.startsWith("/api/admin/") ? admin : ROUTES[path];
    if (!fn) return notFound();
    useDb(env.DB);
    globalThis.NOX_ENV = env;   // (ADMIN_USER, ADMIN_PASS, ADMIN_EMAIL, RESEND_API_KEY, NOX_SALT: set on Cloudflare)
    if (Math.random() < 0.01) ctx.waitUntil(tidy().catch(() => {}));
    try {
      return await fn(req, { ip: req.headers.get("cf-connecting-ip") || "" });
    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ error: "Something went wrong on the Nox website. Try again." }), {
        status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
  },
};
