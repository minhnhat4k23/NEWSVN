import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Parser from "rss-parser";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const FEEDS_PATH = path.join(ROOT, "feeds.json");
export const STATE_PATH = path.join(ROOT, "state.json");
const MAX_ITEMS_PER_RUN = 5;
const SEND_DELAY_MS = 500;

const parser = new Parser();

export async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

export function getWebhookMap() {
  const raw = process.env.DISCORD_WEBHOOKS;
  if (!raw) {
    console.warn("DISCORD_WEBHOOKS is not set - no messages will be sent.");
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("DISCORD_WEBHOOKS is not valid JSON.");
    return {};
  }
}

function itemKey(item) {
  return item.guid || item.link || item.title;
}

function extractImageUrl(item) {
  const html = item.content || item["content:encoded"] || "";
  const match = /<img[^>]+src="([^"]+)"/i.exec(html);
  const url = match?.[1];
  return url && url.startsWith("http") ? url : undefined;
}

export function toEmbed(feedTitle, item) {
  let description = (item.contentSnippet || item.content || "").trim();
  if (description.length > 200) description = description.slice(0, 197) + "...";
  const embed = {
    title: item.title || "(khong co tieu de)",
    url: item.link,
    description,
    timestamp: item.isoDate || undefined,
    author: { name: feedTitle },
    footer: { text: "Ngay dang:" },
  };
  const imageUrl = item.imageUrl;
  if (imageUrl) embed.image = { url: imageUrl };
  return embed;
}

function toLinkButtonRow(url) {
  return [
    {
      type: 1,
      components: [{ type: 2, style: 5, label: "Doc chi tiet ↗", url }],
    },
  ];
}

const MAX_SEND_ATTEMPTS = 3;

export async function sendToDiscord(webhookUrl, embed, opts = {}) {
  const body = { embeds: [embed] };
  if (opts.content) body.content = opts.content;
  if (opts.username) body.username = opts.username;
  if (opts.avatarUrl) body.avatar_url = opts.avatarUrl;
  if (opts.threadName) body.thread_name = opts.threadName.slice(0, 100);
  if (embed.url) body.components = toLinkButtonRow(embed.url);

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt === MAX_SEND_ATTEMPTS) throw err;
      await sleep(1000 * attempt);
      continue;
    }

    if (res.ok) return;

    const isRateLimited = res.status === 429;
    const isServerError = res.status >= 500;
    if ((isRateLimited || isServerError) && attempt < MAX_SEND_ATTEMPTS) {
      const retryAfterSec = isRateLimited ? Number(res.headers.get("retry-after")) || 1 : attempt;
      await sleep((retryAfterSec + 0.5) * 1000);
      continue;
    }

    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook returned ${res.status}: ${text}`);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processFeed(key, feedUrl, state, webhookMap) {
  const webhookUrl = webhookMap[key];
  let parsed;
  try {
    parsed = await parser.parseURL(feedUrl);
  } catch (err) {
    console.warn(`[${key}] Error fetching/parsing feed: ${err.message}`);
    return;
  }

  const items = parsed.items || [];
  if (items.length === 0) {
    console.log(`[${key}] Feed has no items.`);
    return;
  }

  const lastKey = state[key]?.lastKey;

  if (!lastKey) {
    state[key] = { lastKey: itemKey(items[0]) };
    console.log(`[${key}] First time seeing this feed - saving baseline, not sending anything.`);
    return;
  }

  const newItems = [];
  for (const item of items) {
    if (itemKey(item) === lastKey) break;
    newItems.push(item);
  }

  if (newItems.length === 0) {
    console.log(`[${key}] No new articles.`);
    return;
  }

  newItems.reverse();
  const toSend = newItems.slice(-MAX_ITEMS_PER_RUN);
  console.log(`[${key}] Found ${newItems.length} new articles, sending ${toSend.length}.`);

  if (!webhookUrl) {
    console.warn(`[${key}] No webhook URL found in DISCORD_WEBHOOKS - skipping send, state still updated.`);
  } else {
    for (const item of toSend) {
      try {
        item.imageUrl = extractImageUrl(item);
        const embed = toEmbed(parsed.title || key, item);
        await sendToDiscord(webhookUrl, embed, {
          content: embed.description,
          username: parsed.title || key,
          avatarUrl: parsed.image?.url,
          threadName: item.title,
        });
      } catch (err) {
        console.warn(`[${key}] Error sending to Discord for "${item.title}": ${err.message}`);
      }
      await sleep(SEND_DELAY_MS);
    }
  }

  state[key] = { lastKey: itemKey(items[0]) };
}

async function main() {
  const feeds = await readJson(FEEDS_PATH, {});
  const state = await readJson(STATE_PATH, {});
  const webhookMap = getWebhookMap();

  for (const [key, feedUrl] of Object.entries(feeds)) {
    await processFeed(key, feedUrl, state, webhookMap);
  }

  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
  console.log("state.json updated.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
