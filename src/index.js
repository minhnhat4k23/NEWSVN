import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Parser from "rss-parser";

const ROOT = path.resolve(import.meta.dirname, "..");
const FEEDS_PATH = path.join(ROOT, "feeds.json");
const STATE_PATH = path.join(ROOT, "state.json");
const MAX_ITEMS_PER_RUN = 5;
const SEND_DELAY_MS = 500;

const parser = new Parser();

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function getWebhookMap() {
  const raw = process.env.DISCORD_WEBHOOKS;
  if (!raw) {
    console.warn("DISCORD_WEBHOOKS chua duoc set - se khong gui duoc tin nao.");
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("DISCORD_WEBHOOKS khong phai JSON hop le.");
    return {};
  }
}

function itemKey(item) {
  return item.guid || item.link || item.title;
}

function toEmbed(feedTitle, item) {
  let description = (item.contentSnippet || item.content || "").trim();
  if (description.length > 200) description = description.slice(0, 197) + "...";
  const embed = {
    title: item.title || "(khong co tieu de)",
    url: item.link,
    description,
    timestamp: item.isoDate || undefined,
    footer: { text: feedTitle },
  };
  const imageUrl = item.enclosure?.url;
  if (imageUrl) embed.image = { url: imageUrl };
  return embed;
}

async function sendToDiscord(webhookUrl, embed) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook tra ve ${res.status}: ${text}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processFeed(key, feedUrl, state, webhookMap) {
  const webhookUrl = webhookMap[key];
  let parsed;
  try {
    parsed = await parser.parseURL(feedUrl);
  } catch (err) {
    console.warn(`[${key}] Loi khi fetch/parse feed: ${err.message}`);
    return;
  }

  const items = parsed.items || [];
  if (items.length === 0) {
    console.log(`[${key}] Feed khong co item nao.`);
    return;
  }

  const lastKey = state[key]?.lastKey;

  if (!lastKey) {
    state[key] = { lastKey: itemKey(items[0]) };
    console.log(`[${key}] Lan dau gap feed nay - luu baseline, khong gui tin.`);
    return;
  }

  const newItems = [];
  for (const item of items) {
    if (itemKey(item) === lastKey) break;
    newItems.push(item);
  }

  if (newItems.length === 0) {
    console.log(`[${key}] Khong co bai moi.`);
    return;
  }

  newItems.reverse();
  const toSend = newItems.slice(-MAX_ITEMS_PER_RUN);
  console.log(`[${key}] Co ${newItems.length} bai moi, gui ${toSend.length} bai.`);

  if (!webhookUrl) {
    console.warn(`[${key}] Khong tim thay webhook URL trong DISCORD_WEBHOOKS - bo qua gui, van cap nhat state.`);
  } else {
    for (const item of toSend) {
      try {
        await sendToDiscord(webhookUrl, toEmbed(parsed.title || key, item));
      } catch (err) {
        console.warn(`[${key}] Loi gui Discord cho "${item.title}": ${err.message}`);
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
  console.log("Da cap nhat state.json.");
}

main().catch((err) => {
  console.error("Loi khong mong muon:", err);
  process.exit(1);
});
