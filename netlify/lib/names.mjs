// Nox: usernames. Each has one owner (first come, first served) and can't be changed:
// not after a while, not ever (only the Nox admin can reset one). Display names are
// separate: those are picked in the Nox app, can change anytime, and don't come here.
// Kept in Netlify Blobs, store "usernames":
//   u-<username in small letters>  { username, device, at }   who has this username
//                                  { held: true, username, at } reset by the admin: nobody can take it
//   d-<device ID>                  { username, keyHash, at }  this device's username, and its name key
// The name key is a secret the Nox app gets the first time it picks a username (kept in
// nox_name.txt next to it). Device IDs are seen by other players, so only the key can use
// a device's username.

import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";
import { check, hashIp, isDevice } from "./standing.mjs";
import { allow } from "./limits.mjs";

const RESERVED = ["nox", "noxteam", "nox_team", "noxadmin", "admin", "administrator", "moderator", "mod", "owner",
  "system", "server", "staff", "support", "bitform", "bitformstudio", "host", "player", "guest", "everyone", "you"];
export const NAME_RULES = "A username is 3 to 20 letters, numbers or _ (no spaces).";
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const store = () => getStore({ name: "usernames", consistency: "strong" });
export const validName = (n) => /^[A-Za-z0-9_]{3,20}$/.test(n);

// ---- words that aren't allowed (the same lists as the Nox engine: engine/src/online.c) ----
const BAD_ANY = ["nigg", "niglet", "faggot", "fagot", "kike", "chink", "wetback", "tranny", "retard", "hitler", "kkk", "siegheil",
  "fuck", "shit", "cunt", "bitch", "whore", "slut", "pussy", "penis", "vagina", "porn", "pedophil", "paedo",
  "molest", "jizz", "dildo", "hentai", "nutsack", "blowjob", "handjob", "milf"];
const BAD_WORD = ["rape", "rapist", "nazi", "nazis", "heil", "dick", "cock", "sex", "cum", "anal", "spic", "fag", "nig", "coon", "gook",
  "kys", "pedo", "nude", "tits", "boob", "boobs", "ass", "arse", "hoe", "thot"];
const LEET = { 0: "o", 1: "i", "!": "i", "|": "i", 3: "e", 4: "a", "@": "a", 5: "s", $: "s", 7: "t", 8: "b" };
const letters = (s) => [...String(s).toLowerCase()].map((c) => LEET[c] ?? c).filter((c) => c >= "a" && c <= "z").join("");
const squash = (s) => s.replace(/(.)\1+/g, "$1");

export function badName (name) {
  name = String(name || "");
  const all = letters(name), sq = squash(all);
  if (name.includes("1488")) return true;
  for (const w of BAD_ANY) if (all.includes(w) || (squash(w).length >= 4 && sq.includes(squash(w)))) return true;
  if (BAD_WORD.includes(all) || BAD_WORD.includes(sq)) return true;
  // each word of it: split by spaces, _ or -, and where a capital starts (BigDick)
  for (const part of name.replace(/([a-z])(?=[A-Z])/g, "$1 ").split(/[ _-]+/)) {
    const w = letters(part);
    if (BAD_WORD.includes(w) || BAD_WORD.includes(squash(w))) return true;
  }
  return false;
}

// this device's username ("" if none yet). -> { ok, name } or { error, status }
async function mine (s, device, key) {
  const dev = await s.get(`d-${device}`, { type: "json" });
  if (dev && dev.keyHash && (!key || hash(key) !== dev.keyHash))
    return { error: "This copy of Nox lost its name key (nox_name.txt), so it can't use this device's username. Ask the Nox team.", status: 403 };
  let name = (dev && dev.username) || "";
  if (name) {   // (the username's own record has to say this device too)
    const u = await s.get(`u-${name.toLowerCase()}`, { type: "json" });
    if (!u || u.held || u.device !== device) name = "";
  }
  return { ok: true, name, dev };
}

// pick a username for a device (only once), or with name "" just say what it is.
// -> { ok, name, key? } or { error, status }
export async function claimName (device, key, name, ip) {
  device = String(device || "").toLowerCase();
  name = String(name || "").trim();
  if (!isDevice(device)) return { error: "bad request", status: 400 };
  const s = store();
  const m = await mine(s, device, key);
  if (m.error) return m;
  if (!name) return { ok: true, name: m.name };
  if (m.name) {
    if (m.name.toLowerCase() === name.toLowerCase()) return { ok: true, name: m.name };
    return { error: `This device's username is ${m.name}, and usernames can't be changed.`, status: 409, name: m.name };
  }
  if (!validName(name)) return { error: NAME_RULES, status: 400 };
  const low = name.toLowerCase();
  if (RESERVED.includes(low) || badName(name)) return { error: `"${name}" isn't allowed in Nox. Pick another.`, status: 409 };
  const st = await check(device, name, ip);
  if (st.blocked) return { error: st.message, status: 403 };
  if (await s.get(`u-${low}`)) return { error: `The username ${name} is taken. Pick another.`, status: 409 };
  if (!(await allow([`cl-i-${hashIp(String(ip || ""))}`, `cl-d-${device}`], 10))) return { error: "Too many tries for now. Try again later.", status: 429 };
  const newKey = m.dev && m.dev.keyHash ? "" : randomBytes(24).toString("hex");
  const keyHash = newKey ? hash(newKey) : m.dev.keyHash;
  await s.setJSON(`u-${low}`, { username: name, device, at: Date.now() });
  await s.setJSON(`d-${device}`, { username: name, keyHash, at: Date.now() });
  const u = await s.get(`u-${low}`, { type: "json" });   // (someone else at the same moment: the later one has it)
  if (!u || u.device !== device) {
    await s.setJSON(`d-${device}`, { username: "", keyHash: (m.dev && m.dev.keyHash) || "", at: Date.now() });   // (as before)
    return { error: `The username ${name} is taken. Pick another.`, status: 409 };
  }
  return newKey ? { ok: true, name, key: newKey } : { ok: true, name };
}

// is this the device's own username? (a host listing a game under it) -> "" yes, or why not
export async function checkName (device, key, name) {
  device = String(device || "").toLowerCase();
  if (!isDevice(device)) return "bad request";
  const m = await mine(store(), device, key);
  if (m.error) return m.error;
  if (!m.name) return "Pick your username in the Nox app first (Settings).";
  if (m.name.toLowerCase() !== String(name || "").toLowerCase()) return `This device's username is ${m.name}.`;
  return "";
}

// who this device is: its username, proven by its name key. -> { name } or { error, status }
export async function whoIs (device, key) {
  device = String(device || "").toLowerCase();
  if (!isDevice(device)) return { error: "bad request", status: 400 };
  const m = await mine(store(), device, String(key || ""));
  if (m.error) return m;
  if (!m.name) return { error: "Pick your username in the Nox app first (Settings).", status: 403 };
  return { name: m.name, device };
}

// a username as its owner spelled it ("" if nobody has it)
export async function realName (name) {
  name = String(name || "");
  if (!validName(name)) return "";
  const n = await store().get(`u-${name.toLowerCase()}`, { type: "json" });
  return n && !n.held && n.username ? n.username : "";
}

export async function nameInfo (name) {
  const n = await store().get(`u-${String(name || "").toLowerCase()}`, { type: "json" });
  return n && !n.held ? { name: n.username, device: n.device, at: n.at } : n ? { name: n.username || String(name), held: true, at: n.at } : null;
}

// the admin resets a username: its device has to pick a new one. hold: nobody can take
// this one afterwards (a bad name); otherwise it's free for anyone again.
export async function freeName (name, hold) {
  const s = store(), low = String(name || "").toLowerCase();
  const n = await s.get(`u-${low}`, { type: "json" });
  if (!n) return false;
  if (hold) await s.setJSON(`u-${low}`, { held: true, username: n.username || String(name), at: Date.now() });
  else await s.delete(`u-${low}`);
  // (its key goes too: that device starts fresh, which also helps someone who lost nox_name.txt)
  if (n.device) await s.setJSON(`d-${n.device}`, { username: "", keyHash: "", at: Date.now() });
  // its friends and what it was playing go too (whoever has this username next starts with none)
  const fs = getStore({ name: "friends", consistency: "strong" });
  const f = await fs.get(`f-${low}`, { type: "json" });
  if (f) {
    const others = new Set([...(f.friends || []), ...(f.incoming || []), ...(f.outgoing || [])].map((x) => String(x).toLowerCase()));
    for (const o of others) {
      const r = await fs.get(`f-${o}`, { type: "json" });
      if (!r) continue;
      for (const k of ["friends", "incoming", "outgoing"]) r[k] = (r[k] || []).filter((x) => String(x).toLowerCase() !== low);
      await fs.setJSON(`f-${o}`, r);
    }
    await fs.delete(`f-${low}`);
  }
  await getStore({ name: "presence", consistency: "strong" }).delete(`p-${low}`);
  return true;
}
