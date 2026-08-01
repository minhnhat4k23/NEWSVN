import * as cheerio from "cheerio";
import {
  STATE_PATH,
  BROWSER_USER_AGENT,
  BOT_AVATAR_URL,
  readJson,
  getWebhookMap,
  toEmbed,
  sendToDiscord,
  fetchImageAttachment,
  sleep,
} from "./index.js";

const CATEGORY_PAGES = {
  "thoi-su": "thoi-su",
  "the-gioi": "the-gioi",
  "phap-luat": "phap-luat",
  "giao-duc": "giao-duc",
  "khoa-hoc-cong-nghe": "khoa-hoc-cong-nghe",
  "kinh-doanh": "kinh-doanh",
  "suc-khoe": "suc-khoe",
  "du-lich": "du-lich",
  "gia-dinh": "doi-song",
  "tam-su": "tam-su",
  "tam-su-2": "y-kien",
};

const MAX_BACKFILL_PER_CHANNEL = 30;
const BACKFILL_MONTHS = 3;
const MAX_PAGES = 10;
const SEND_DELAY_MS = 500;
const USER_AGENT = BROWSER_USER_AGENT;

function articleId(link) {
  const match = /-(\d+)\.html$/.exec(link || "");
  return match ? Number(match[1]) : null;
}

async function fetchListingPage(slug, pageNum) {
  const url =
    pageNum === 1
      ? `https://vnexpress.net/${slug}`
      : `https://vnexpress.net/${slug}-p${pageNum}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} while loading ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const items = [];
  $("article").each((_, el) => {
    const titleLink = $(el)
      .find("h2.title_news a, h3.title_news a, h2.title-news a, h3.title-news a")
      .first();
    const link = titleLink.attr("href");
    const title = titleLink.text().trim();
    if (!link || !title) return;
    const thumb = $(el).find("img").first();
    const rawImage =
      thumb.attr("data-original") ||
      thumb.attr("data-src") ||
      thumb.attr("data-original-src") ||
      thumb.attr("src");
    const imageUrl = rawImage && rawImage.startsWith("http") ? rawImage : undefined;
    const intro = $(el).find("p.description, p.short_intro").first().clone();
    intro.find("span.meta-news, a.icon_commend, a.count_cmt, span.location-stamp").remove();
    const contentSnippet = intro.text().trim();
    items.push({ link, title, imageUrl, contentSnippet, guid: link });
  });
  return items;
}

async function fetchPublishDate(link) {
  try {
    const res = await fetch(link, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    const html = await res.text();
    const tagMatch = /<meta[^>]*name="pubdate"[^>]*>/i.exec(html);
    if (!tagMatch) return null;
    const contentMatch = /content="([^"]+)"/i.exec(tagMatch[0]);
    return contentMatch ? contentMatch[1] : null;
  } catch {
    return null;
  }
}

async function collectBackfillItems(key, slug, lastKey) {
  const lastId = lastKey ? articleId(lastKey) : null;
  const collected = [];
  const seenIds = new Set();

  for (let page = 1; page <= MAX_PAGES && collected.length < MAX_BACKFILL_PER_CHANNEL; page++) {
    let pageItems;
    try {
      pageItems = await fetchListingPage(slug, page);
    } catch (err) {
      console.warn(`[${key}] Error loading page ${page}: ${err.message}`);
      break;
    }
    if (pageItems.length === 0) break;

    for (const item of pageItems) {
      const id = articleId(item.link);
      if (id == null || seenIds.has(id)) continue;
      seenIds.add(id);
      if (lastId != null && id >= lastId) continue;
      collected.push(item);
      if (collected.length >= MAX_BACKFILL_PER_CHANNEL) break;
    }
  }

  return collected;
}

async function backfillChannel(key, state, webhookMap) {
  const slug = CATEGORY_PAGES[key];
  if (!slug) {
    console.warn(`[${key}] No matching category page, skipping.`);
    return;
  }

  const lastKey = state[key]?.lastKey;
  const items = await collectBackfillItems(key, slug, lastKey);

  if (items.length === 0) {
    console.log(`[${key}] No older articles found to backfill.`);
    return;
  }

  const oldest = items[items.length - 1];
  const oldestDate = await fetchPublishDate(oldest.link);
  const coverageMsg = oldestDate
    ? `oldest article dated ${oldestDate}`
    : "could not get the oldest article's date";
  console.log(`[${key}] Found ${items.length} articles, ${coverageMsg}.`);

  const webhookUrl = webhookMap[key];
  if (!webhookUrl) {
    console.warn(`[${key}] No webhook in DISCORD_WEBHOOKS - stats only, not sending.`);
    return;
  }

  const toSend = [...items].reverse();
  for (const item of toSend) {
    try {
      const embed = toEmbed(`VnExpress (backfill)`, item);
      await sendToDiscord(webhookUrl, embed, {
        content: embed.description,
        username: key,
        avatarUrl: BOT_AVATAR_URL,
        threadName: item.title,
        attachment: await fetchImageAttachment(item.imageUrl),
      });
    } catch (err) {
      console.warn(`[${key}] Error sending backfill item "${item.title}": ${err.message}`);
    }
    await sleep(SEND_DELAY_MS);
  }
}

async function main() {
  console.log(
    `Backfilling up to ${MAX_BACKFILL_PER_CHANNEL} articles/channel, targeting the last ${BACKFILL_MONTHS} months.`
  );
  const state = await readJson(STATE_PATH, {});
  const webhookMap = getWebhookMap();

  for (const key of Object.keys(CATEGORY_PAGES)) {
    await backfillChannel(key, state, webhookMap);
  }

  console.log("Backfill complete. state.json was NOT modified.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
