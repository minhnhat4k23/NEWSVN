# vnexpress-discord-bot

Bot that automatically posts VnExpress RSS articles to matching Discord channels, running entirely on GitHub Actions (cron) - no dedicated server required.

## How it works

Every 5 minutes, GitHub Actions runs `src/index.js`: it reads `feeds.json` (channel key -> RSS URL), compares against `state.json` (the last article sent per channel), and if there's anything new it posts an embed via Discord Webhook, then commits the updated `state.json` back to the repo.

Sending is resilient to transient failures: network errors, Discord rate limits (429), and Discord server errors (5xx) are retried automatically with backoff. Genuine errors (bad payload, missing permissions) fail immediately without retrying.

There's also a one-off `src/backfill.js` script (not run by the cron workflow) that scrapes VnExpress category listing pages directly - RSS only exposes the ~20-60 most recent items, not enough history - to backfill up to 30 older articles per channel. It never touches `state.json`, so it won't interfere with the live cron.

## Setup

### 1. Create a Discord Webhook for each channel

For every Discord channel you want to receive articles:

1. Go to **Channel Settings** -> **Integrations** -> **Webhooks** -> **New Webhook**.
2. Name it, then copy the **Webhook URL**.

Do this for every channel listed in `feeds.json` (see that file for the list of keys).

### 2. Create the GitHub repo and push the code

```bash
gh repo create <repo-name> --public --source=. --remote=origin --push
```

### 3. Add a GitHub Secret with all webhooks combined

On the repo's GitHub page -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**:

- Name: `DISCORD_WEBHOOKS`
- Value: a single JSON object combining all webhook URLs, with keys matching `feeds.json`, e.g.:

```json
{
  "thoi-su": "https://discord.com/api/webhooks/xxx/yyy",
  "phap-luat": "https://discord.com/api/webhooks/xxx/yyy"
}
```

Any channel missing from this JSON is simply skipped (no error, just a warning in the logs).

### 4. Try it out

- **Locally**: `npm install`, then `DISCORD_WEBHOOKS='{"thoi-su":"<webhook-url>"}' node src/index.js` (PowerShell: set `$env:DISCORD_WEBHOOKS='...'` first). The very first run for a new feed sends nothing (it only saves a baseline) - run it a second time to see new articles actually delivered.
- **On GitHub**: go to the **Actions** tab -> select the **RSS to Discord** workflow -> **Run workflow** to trigger it immediately without waiting for the schedule.

### 5. (Optional) Backfill older articles

```bash
DISCORD_WEBHOOKS='{"thoi-su":"<webhook-url>", ...}' node src/backfill.js
```

Logs how many articles were found per channel and how far back the oldest one dates, then sends them oldest-first. Safe to re-run; it only ever sends articles older than each channel's current `state.json` pointer.

## Editing the feed list

Edit `feeds.json` directly to add, remove, or change RSS URLs - no code changes needed.
