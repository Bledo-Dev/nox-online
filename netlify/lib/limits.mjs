// Nox: simple limits so nobody can flood the website (counts per hour, in Netlify Blobs).

import { getStore } from "@netlify/blobs";

// one more for each of these keys this hour; false if any is already at max
export async function allow (keys, max) {
  const rl = getStore({ name: "limits", consistency: "strong" });
  const hour = Math.floor(Date.now() / 3600000);
  const counts = [];
  for (const k of keys) {
    const c = (await rl.get(`${k}-${hour}`, { type: "json" })) || { n: 0 };
    if (c.n >= max) return false;
    counts.push(c.n);
  }
  for (let i = 0; i < keys.length; i++) await rl.setJSON(`${keys[i]}-${hour}`, { n: counts[i] + 1 });
  return true;
}
