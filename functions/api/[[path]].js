// Nox online on Cloudflare Pages: every /api/... request comes here, and goes to worker.mjs
// (the pages in public/ are served by Cloudflare as they are, without running this).
import worker from "../../worker.mjs";

export const onRequest = (ctx) => worker.fetch(ctx.request, ctx.env, { waitUntil: (p) => ctx.waitUntil(p) });
