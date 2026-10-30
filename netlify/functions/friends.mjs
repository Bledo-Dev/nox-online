// Nox: friends (the Nox app's Friends tab), and what friends are playing.
//
//   POST /api/friends  { device, key, action, name?, code?, game? }
//     list                 -> { me, friends: [{ name, playing? }], incoming: [names], outgoing: [names] }
//     add      name        send a friend request (or accept theirs, if they already sent one)
//     accept   name        accept their request
//     decline  name        say no to their request
//     remove   name        not friends anymore (or take back a request you sent)
//     playing  code, game  this player is in a game (code: its online code, if it has one)
//     stopped              ...and left it
//   The device and its name key (nox_name.txt) say who's asking (lib/names.mjs).
//
// Kept in Netlify Blobs:
//   store "friends":   f-<username, small letters>  { name, friends: [...], incoming: [...], outgoing: [...] }
//   store "presence":  p-<username, small letters>  { game, code, at }   (only friends see it; 5 minutes old = gone)

import { getStore } from "@netlify/blobs";
import { whoIs, realName, validName } from "../lib/names.mjs";
import { check } from "../lib/standing.mjs";
import { allow } from "../lib/limits.mjs";
import { playing, setPlaying } from "../lib/presence.mjs";

const MAX_FRIENDS = 200, MAX_INCOMING = 100;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").slice(0, max);
const low = (n) => String(n).toLowerCase();
const friends = () => getStore({ name: "friends", consistency: "strong" });

async function load (name) {
  const r = (await friends().get(`f-${low(name)}`, { type: "json" })) || {};
  return { name, friends: r.friends || [], incoming: r.incoming || [], outgoing: r.outgoing || [] };
}
const save = (r) => friends().setJSON(`f-${low(r.name)}`, r);
const has = (list, n) => list.some((x) => low(x) === low(n));
const without = (list, n) => list.filter((x) => low(x) !== low(n));

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const who = await whoIs(b.device, b.key);
  if (who.error) return json({ error: who.error }, who.status);
  const me = who.name, action = String(b.action || "");

  if (action === "list") {
    if (!(await allow([`fl-d-${who.device}`], 300))) return json({ error: "Too many updates for now." }, 429);
    const r = await load(me), names = r.friends.slice(0, MAX_FRIENDS), list = [];
    for (let i = 0; i < names.length; i += 25) {   // (what each is playing: 25 at a time)
      const got = await Promise.all(names.slice(i, i + 25).map((f) => playing(f)));
      got.forEach((p, k) => list.push({ name: names[i + k], playing: p }));
    }
    list.sort((x, y) => (!!y.playing - !!x.playing) || low(x.name).localeCompare(low(y.name)));
    return json({ me, friends: list, incoming: r.incoming, outgoing: r.outgoing });
  }
  if (action === "playing") {
    if (!(await allow([`pr-d-${who.device}`], 120))) return json({ error: "Too many updates." }, 429);
    await setPlaying(me, b.game, String(b.code || "").toUpperCase());
    return json({ ok: true });
  }
  if (action === "stopped") {
    await setPlaying(me, null);
    return json({ ok: true });
  }
  if (!["add", "accept", "decline", "remove"].includes(action)) return json({ error: "bad request" }, 400);
  if (!(await allow([`fx-d-${who.device}`], 60))) return json({ error: "Too many changes for now. Try again later." }, 429);

  // (decline and remove also work for a username nobody has anymore: it just leaves your lists)
  const real = await realName(b.name);
  const other = real || ((action === "decline" || action === "remove") && validName(String(b.name || "")) ? String(b.name) : "");
  if (!other) return json({ error: `Nobody has the username ${clean(b.name, 24)}.` }, 404);
  if (low(other) === low(me)) return json({ error: "That's you." }, 400);
  const mine = await load(me), theirs = real ? await load(other) : { name: other, friends: [], incoming: [], outgoing: [] };
  const saveBoth = async () => { await save(mine); if (real) await save(theirs); };

  if (action === "add") {
    const st = await check(who.device, me, String(context.ip ?? ""));
    if (st.blocked) return json({ error: st.message }, 403);
    if (has(mine.friends, other)) return json({ error: `You and ${other} are already friends.` }, 409);
    if (!(await allow([`fr-d-${who.device}`], 30))) return json({ error: "Too many friend requests for now. Try again later." }, 429);
    if (has(mine.incoming, other)) {   // they asked first: friends now
      if (mine.friends.length >= MAX_FRIENDS || theirs.friends.length >= MAX_FRIENDS) return json({ error: "Too many friends." }, 409);
      mine.incoming = without(mine.incoming, other); theirs.outgoing = without(theirs.outgoing, me);
      mine.friends.push(other); theirs.friends.push(me);
      await save(mine); await save(theirs);
      return json({ ok: true, friends: true, message: `You and ${other} are friends now.` });
    }
    if (has(mine.outgoing, other)) return json({ ok: true, message: `You already sent ${other} a request.` });
    if (mine.friends.length >= MAX_FRIENDS) return json({ error: "You have the most friends Nox allows (200)." }, 409);
    if (theirs.incoming.length >= MAX_INCOMING) return json({ error: `${other} can't get more friend requests right now.` }, 409);
    mine.outgoing.push(other); theirs.incoming.push(me);
    await save(mine); await save(theirs);
    return json({ ok: true, message: `Friend request sent to ${other}.` });
  }
  if (action === "accept") {
    if (!has(mine.incoming, other)) return json({ error: `${other} didn't send you a request.` }, 404);
    if (mine.friends.length >= MAX_FRIENDS || theirs.friends.length >= MAX_FRIENDS) return json({ error: "Too many friends." }, 409);
    mine.incoming = without(mine.incoming, other); theirs.outgoing = without(theirs.outgoing, me);
    if (!has(mine.friends, other)) mine.friends.push(other);
    if (!has(theirs.friends, me)) theirs.friends.push(me);
    await save(mine); await save(theirs);
    return json({ ok: true, message: `You and ${other} are friends now.` });
  }
  if (action === "decline") {
    if (!has(mine.incoming, other)) return json({ ok: true });   // (nothing to change: nothing written)
    mine.incoming = without(mine.incoming, other); theirs.outgoing = without(theirs.outgoing, me);
    await saveBoth();
    return json({ ok: true });
  }
  // remove: not friends anymore, and no requests either way
  if (!has(mine.friends, other) && !has(mine.outgoing, other) && !has(mine.incoming, other)) return json({ ok: true });
  mine.friends = without(mine.friends, other); theirs.friends = without(theirs.friends, me);
  mine.outgoing = without(mine.outgoing, other); theirs.incoming = without(theirs.incoming, me);
  mine.incoming = without(mine.incoming, other); theirs.outgoing = without(theirs.outgoing, me);
  await saveBoth();
  return json({ ok: true });
};

export const config = { path: "/api/friends" };
