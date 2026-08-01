import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Parser from "rss-parser";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const FEEDS_PATH = path.join(ROOT, "feeds.json");
export const STATE_PATH = path.join(ROOT, "state.json");
const SEND_DELAY_MS = 500;
// How many delivered article keys to remember per channel. Must comfortably
// exceed a feed's length so an article can never fall out of the list while
// still being present in the feed.
const SEEN_LIMIT = 300;

const parser = new Parser({ timeout: 30000 });

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

function publishedAt(item) {
  const parsed = Date.parse(item.isoDate || item.pubDate || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function byOldestFirst(items) {
  return [...items].sort((a, b) => publishedAt(a) - publishedAt(b));
}

// Midnight today, Vietnam time (UTC+7), as an epoch value.
function startOfTodayVietnam() {
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const vnNow = Date.now() + VN_OFFSET_MS;
  return Math.floor(vnNow / 86400000) * 86400000 - VN_OFFSET_MS;
}

// Old state stored a single {lastKey} pointer, which silently skipped articles.
// Rebuild a seen-list from it: everything published before today counts as
// handled, so today's articles get delivered even if the pointer had jumped
// past them.
function migrateFromPointer(key, items) {
  const cutoff = startOfTodayVietnam();
  const older = byOldestFirst(items).filter((item) => publishedAt(item) < cutoff);
  const todays = items.length - older.length;
  console.log(
    `[${key}] Migrating state to a seen-list; ${todays} article(s) from today will be re-checked.`
  );
  return older.map(itemKey);
}

// vnecdn.net answers 403 to Discord's image fetcher, so linking an article
// image directly leaves the embed blank. Downloading it ourselves and
// uploading it as an attachment sidesteps that entirely.
// vnecdn.net also 403s Discord when it tries to fetch the feed's own logo for
// the webhook avatar, so the avatar is served from this repo instead.
export const BOT_AVATAR_URL =
  "https://raw.githubusercontent.com/minhnhat4k23/NEWSVN/master/assets/avatar.png";

// Feed titles arrive as "Phap luat - VnExpress RSS"; the "RSS" suffix is noise
// for readers.
export function feedDisplayName(feedTitle, key) {
  const title = (feedTitle || "").trim();
  if (!title) return key;
  return title.replace(/\s+RSS$/i, "");
}

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export async function fetchImageAttachment(url) {
  if (!url || !url.startsWith("http")) return null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    return { blob: new Blob([bytes], { type }), filename: `image.${ext}` };
  } catch {
    return null;
  }
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

function toMultipartBody(payload, attachment) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append("files[0]", attachment.blob, attachment.filename);
  return form;
}

export async function sendToDiscord(webhookUrl, embed, opts = {}) {
  const attachment = opts.attachment;
  const finalEmbed = attachment
    ? { ...embed, image: { url: `attachment://${attachment.filename}` } }
    : embed;

  const body = { embeds: [finalEmbed] };
  if (opts.content) body.content = opts.content;
  if (opts.username) body.username = opts.username;
  if (opts.avatarUrl) body.avatar_url = opts.avatarUrl;
  if (opts.threadName) body.thread_name = opts.threadName.slice(0, 100);
  if (finalEmbed.url) body.components = toLinkButtonRow(finalEmbed.url);

  // Discord silently drops `components` from webhook messages unless this flag is set.
  const endpoint = new URL(webhookUrl);
  endpoint.searchParams.set("with_components", "true");

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    // Rebuilt per attempt so a retry never reuses a consumed body.
    const request = attachment
      ? { method: "POST", body: toMultipartBody(body, attachment) }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };

    let res;
    try {
      // Without a deadline a stalled upload hangs the whole run forever.
      res = await fetch(endpoint, { ...request, signal: AbortSignal.timeout(60000) });
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

  const entry = state[key];

  if (!entry) {
    state[key] = { seen: byOldestFirst(items).map(itemKey).slice(-SEEN_LIMIT) };
    console.log(`[${key}] First time seeing this feed - saving baseline, not sending anything.`);
    return;
  }

  // VnExpress does not order its feed strictly by publication time - an article
  // published an hour ago can sit below one from yesterday. Walking the feed
  // until a single stored pointer matches therefore skips anything below that
  // pointer, permanently. Track the set of delivered articles instead, so a
  // article's position in the feed stops mattering.
  const seen = Array.isArray(entry.seen) ? [...entry.seen] : migrateFromPointer(key, items);
  const known = new Set(seen);
  const newItems = items.filter((item) => !known.has(itemKey(item)));

  if (newItems.length === 0) {
    console.log(`[${key}] No new articles.`);
    state[key] = { seen: seen.slice(-SEEN_LIMIT) };
    return;
  }

  // Oldest first, so a channel reads top-to-bottom in publication order.
  const toSend = newItems.sort((a, b) => publishedAt(a) - publishedAt(b));
  console.log(`[${key}] Found ${toSend.length} new articles, sending all of them.`);

  if (!webhookUrl) {
    // Don't advance the pointer: these articles were never delivered, and
    // burning them here would lose them permanently.
    console.warn(`[${key}] No webhook URL found in DISCORD_WEBHOOKS - skipping, will retry next run.`);
    return;
  }

  // The pointer may only move over articles Discord actually accepted. On the
  // first rejection we stop, so the run after this one resumes from that
  // article instead of skipping past it. Discord rejects with
  // "Maximum number of active threads reached" once a forum is full, and that
  // clears itself as older posts archive.
  for (const item of toSend) {
    try {
      item.imageUrl = extractImageUrl(item);
      const displayName = feedDisplayName(parsed.title, key);
      const embed = toEmbed(displayName, item);
      await sendToDiscord(webhookUrl, embed, {
        content: embed.description,
        username: displayName,
        avatarUrl: BOT_AVATAR_URL,
        threadName: item.title,
        attachment: await fetchImageAttachment(item.imageUrl),
      });
      seen.push(itemKey(item));
    } catch (err) {
      console.warn(
        `[${key}] Discord rejected "${item.title}": ${err.message} - stopping here, will resume from this article next run.`
      );
      break;
    }
    await sleep(SEND_DELAY_MS);
  }

  state[key] = { seen: seen.slice(-SEEN_LIMIT) };
}

async function main() {
  const feeds = await readJson(FEEDS_PATH, {});
  const state = await readJson(STATE_PATH, {});
  const webhookMap = getWebhookMap();

  // Each channel has its own webhook, so its own Discord rate-limit bucket -
  // running them concurrently is much faster than one after another.
  await Promise.all(
    Object.entries(feeds).map(([key, feedUrl]) => processFeed(key, feedUrl, state, webhookMap))
  );

  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
  console.log("state.json updated.");
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
