// Nox: player names, one owner each (first come, first served). Kept in Netlify Blobs,
// store "names":
//   n-<name in small letters>  { name, device, at }      who has this name
//   d-<device ID>              { name, keyHash, at }     this device's name, and its name key
// The name key is a secret the Nox app gets the first time it claims a name (kept in
// nox_name.txt next to it). Device IDs are seen by other players, so only the key can
// change or keep a device's name.

import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";
import { check, isDevice } from "./standing.mjs";

const RESERVED = ["nox", "noxteam", "nox_team", "noxadmin", "admin", "administrator", "moderator", "mod", "owner",
  "system", "server", "staff", "support", "bitform", "bitformstudio", "host", "player", "guest", "everyone"];
export const NAME_RULES = "A name is 3 to 20 letters, numbers or _ (no spaces).";
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const store = () => getStore({ name: "names", consistency: "strong" });
export const validName = (n) => /^[A-Za-z0-9_]{3,20}$/.test(n);

// claim (or keep) a name for a device. -> { ok, name, key? } or { error, status }
export async function claimName (device, key, name, ip) {
  device = String(device || "").toLowerCase();
  name = String(name || "").trim();
  if (!isDevice(device)) return { error: "bad request", status: 400 };
  if (!validName(name)) return { error: NAME_RULES, status: 400 };
  const low = name.toLowerCase();
  if (RESERVED.includes(low)) return { error: `"${name}" can't be used. Pick another name.`, status: 409 };
  const st = await check(device, name, ip);
  if (st.blocked) return { error: st.message, status: 403 };
  const s = store();
  const dev = await s.get(`d-${device}`, { type: "json" });
  let newKey = "";
  if (dev && dev.keyHash) {   // this device has had a name before: only its key may change it
    if (!key || hash(key) !== dev.keyHash) return { error: "This copy of Nox lost its name key (nox_name.txt), so it can't use this device's name.", status: 403 };
  }
  const taken = await s.get(`n-${low}`, { type: "json" });
  if (taken && taken.device !== device) return { error: `The name ${name} is taken. Pick another.`, status: 409 };
  if (!dev || !dev.keyHash) newKey = randomBytes(24).toString("hex");
  if (dev && dev.name && dev.name.toLowerCase() !== low) {   // a new name: the old one is free again
    const old = await s.get(`n-${dev.name.toLowerCase()}`, { type: "json" });
    if (old && old.device === device) await s.delete(`n-${dev.name.toLowerCase()}`);
  }
  await s.setJSON(`n-${low}`, { name, device, at: (taken && taken.at) || Date.now() });
  await s.setJSON(`d-${device}`, { name, keyHash: newKey ? hash(newKey) : dev.keyHash, at: Date.now() });
  return newKey ? { ok: true, name, key: newKey } : { ok: true, name };
}

export async function nameInfo (name) {
  return await store().get(`n-${String(name || "").toLowerCase()}`, { type: "json" });
}

// the admin takes a name away (its device has to pick a new one)
export async function freeName (name) {
  const s = store(), low = String(name || "").toLowerCase();
  const n = await s.get(`n-${low}`, { type: "json" });
  if (!n) return false;
  await s.delete(`n-${low}`);
  // (its key goes too: that device starts fresh, which also helps someone who lost nox_name.txt)
  const dev = await s.get(`d-${n.device}`, { type: "json" });
  if (dev) await s.setJSON(`d-${n.device}`, { name: "", keyHash: "", at: Date.now() });
  return true;
}
