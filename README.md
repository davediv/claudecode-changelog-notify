# ClaudeCode Changelog Notify

Cloudflare Worker that monitors the Claude Code changelog every 15 minutes and sends notifications to Telegram, Discord, and/or Slack when new updates are detected.

## Features

- Scheduled checks every 15 minutes using Cloudflare Workers Cron Triggers
- Automatic changelog diffing to detect only new updates
- Multi-platform notifications (Telegram, Discord, Slack) - configure one or all
- Stores last seen version in Cloudflare KV to avoid duplicate notifications

## Setup

### 1. Create KV Namespace

```bash
wrangler kv namespace create claudecode-changelog-notify-kv
```

Copy the `id` from the output and update `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "KV",
    "id": "YOUR_KV_NAMESPACE_ID"
  }
]
```

### 2. Configure Notification Platforms

Set secrets for the platforms you want to use. You only need to configure the platforms you want notifications on.

#### Telegram

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put TELEGRAM_THREAD_ID  # Optional: for forum topics
```

#### Discord

```bash
wrangler secret put DISCORD_WEBHOOK_URL
```

#### Slack

```bash
wrangler secret put SLACK_WEBHOOK_URL
```

### 3. Deploy

```bash
npm run deploy
```

## Development

```bash
npm run dev
```

Test the scheduled handler:

```bash
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

Or trigger a manual check:

```bash
curl "http://localhost:8787/check"
```

## How It Works

1. Every 15 minutes, the worker fetches the Claude Code changelog
2. Parses the markdown to extract version entries
3. Compares with the last seen version stored in KV
4. If new versions are found, sends notifications to all configured platforms
5. Updates the last seen version in KV

On first run, it stores the current latest version without sending notifications.
