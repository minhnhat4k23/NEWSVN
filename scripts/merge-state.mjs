// Union two state files into the second one.
//
// Two runs can finish close enough together that both have delivered articles
// and both want to write state.json. Whoever pushes second must not discard
// the other's record - those articles are already in Discord, and dropping
// them from the seen-list makes the next run post them again. Taking the union
// keeps both sets of deliveries.
//
// Usage: node scripts/merge-state.mjs <ours.json> <target.json>

import { readFile, writeFile } from "node:fs/promises";

const SEEN_LIMIT = 300;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

function keysOf(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.seen)) return entry.seen;
  return entry.lastKey ? [entry.lastKey] : [];
}

const [oursPath, targetPath] = process.argv.slice(2);
if (!oursPath || !targetPath) {
  console.error("usage: merge-state.mjs <ours.json> <target.json>");
  process.exit(1);
}

const ours = await readJson(oursPath);
const target = await readJson(targetPath);
const merged = {};

for (const channel of new Set([...Object.keys(target), ...Object.keys(ours)])) {
  // Target (the version already on the remote) goes first so that the newest
  // entries - ours - survive the tail-trim.
  const combined = [...keysOf(target[channel]), ...keysOf(ours[channel])];
  merged[channel] = { seen: [...new Set(combined)].slice(-SEEN_LIMIT) };
}

await writeFile(targetPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");

const added = Object.entries(merged).reduce(
  (n, [ch, v]) => n + (v.seen.length - keysOf(target[ch]).length),
  0
);
console.log(`merged state for ${Object.keys(merged).length} channel(s); ${added} key(s) added`);
