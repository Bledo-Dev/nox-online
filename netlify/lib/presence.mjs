// Nox: what a player is playing, for their friends (the Nox app's Friends tab).
// Netlify Blobs, store "presence":  p-<username, small letters>  { game, code, at }
// (5 minutes old = gone: the app and hosts say it again every 2 minutes)
// The code is only kept for a game in the list of games online, or a friends-only one:
// an invite-only game's code stays with the people the host gave it to.

import { getStore } from "@netlify/blobs";
import { badName } from "./names.mjs";

const FRESH = 5 * 60 * 1000;
const store = () => getStore({ name: "presence", consistency: "strong" });
const low = (n) => String(n).toLowerCase();
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").slice(0, max);

// what a player is playing (null: nothing, or not lately)
export async function playing (name) {
  const p = await store().get(`p-${low(name)}`, { type: "json" });
  if (!p || Date.now() - p.at > FRESH) return null;
  return p.code ? { game: p.game, code: p.code } : { game: p.game };
}

// in a game now (code: its online code, if it has one), or not (game null).
// listing: the game's entry in the list (games.mjs), if known already
export async function setPlaying (name, game, code, listing) {
  if (game === null) { await store().delete(`p-${low(name)}`); return; }
  code = /^[A-Z0-9]{6}$/.test(code || "") ? code : "";
  if (code) {
    const g = listing || (await getStore({ name: "games", consistency: "strong" }).get(code, { type: "json" }));
    if (!g || (g.private && !g.friends)) code = "";
  }
  game = clean(game, 48);
  if (!game || badName(game)) game = "A Nox game";
  await store().setJSON(`p-${low(name)}`, { game, code, at: Date.now() });
}
