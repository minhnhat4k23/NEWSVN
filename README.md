# vnexpress-discord-bot

Bot tu dong dang tin RSS VnExpress vao cac channel Discord tuong ung, chay hoan toan tren GitHub Actions (cron) - khong can server rieng.

## Cach hoat dong

Moi 15 phut, GitHub Actions chay `src/index.js`: doc `feeds.json` (map ten kenh -> RSS URL), so voi `state.json` (bai da gui lan truoc), neu co bai moi thi gui embed qua Discord Webhook, roi commit lai `state.json`.

## Setup

### 1. Tao Discord Webhook cho tung channel

Voi moi channel Discord muon nhan tin:

1. Vao **Channel Settings** -> **Integrations** -> **Webhooks** -> **New Webhook**.
2. Dat ten, copy **Webhook URL**.

Lam nhu vay cho tat ca channel trong `feeds.json` (xem file do de biet danh sach key).

### 2. Tao GitHub repo va push code

```bash
gh repo create <ten-repo> --public --source=. --remote=origin --push
```

### 3. Them GitHub Secret gop tat ca webhook

Vao repo tren GitHub -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**:

- Name: `DISCORD_WEBHOOKS`
- Value: JSON gop tat ca webhook URL, key phai trung voi key trong `feeds.json`, vi du:

```json
{
  "thoi-su": "https://discord.com/api/webhooks/xxx/yyy",
  "phap-luat": "https://discord.com/api/webhooks/xxx/yyy"
}
```

Kenh nao khong co trong JSON nay se bi bo qua (khong loi, chi log canh bao).

### 4. Chay thu

- **Local**: `npm install` roi `DISCORD_WEBHOOKS='{"thoi-su":"<webhook-url>"}' node src/index.js` (PowerShell: dung `$env:DISCORD_WEBHOOKS='...'` truoc khi chay). Lan chay dau tien voi feed moi se khong gui gi (chi luu baseline) - chay lan 2 moi thay bai moi duoc gui.
- **Tren GitHub**: tab **Actions** -> chon workflow **RSS to Discord** -> **Run workflow** de chay thu ngay khong can doi cron.

## Chinh sua danh sach feed

Sua truc tiep `feeds.json` - them/bot/doi RSS URL, khong can dong code nao.
