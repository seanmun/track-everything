# LifeLog

A single-user **personal health data lake**. Telegram is the fast manual-input pipe; Oura wearable data is pulled automatically. An LLM parses everything into structured, timestamped entries in one SQLite database. Computer vision analyzes selfies for facial bloating/skin tracking. Bloodwork PDFs/images become structured biomarker time-series. On-demand analysis surfaces trends and correlations — above all, the cause of episodic facial bloating.

## How it works

```
Telegram ──text/photo/file──▶ Ingest Bot (grammy) ─┐
node-cron ──nightly──▶ Oura API v2 ────────────────┤──▶ SQLite (one DB)
hono HTTP ──OAuth callback──▶ Oura tokens ──────────┘
                              Analyzers (Anthropic: parse / vision / bloodwork / correlation)
```

- **Capture everything, lose nothing.** Every inbound message/photo/file is stored raw (and saved to disk) **before** any LLM call. Derived `entries` and `biomarkers` can always be rebuilt from raw via `/reprocess`.
- **Pull what can be pulled; type only what can't.** Sleep, steps, HRV, readiness, body-temp deviation come from Oura nightly. You only type what no device captures (food, alcohol, mood, bloat, routines, environment).

## Stack

TypeScript (strict) · Node 20+ · grammy · better-sqlite3 + drizzle-orm · Anthropic API (`@anthropic-ai/sdk`) · Oura API v2 · node-cron · hono · zod · pm2.

**Models:** parsing/vision/bloodwork `claude-sonnet-4-6`; correlation analysis `claude-opus-4-8`.

> **Note on Oura:** the spec named the `oura_api` npm package, but it does not implement OAuth refresh-token rotation (required so you authorize only once). LifeLog therefore calls the documented Oura **v2 REST endpoints** directly with a self-managed, auto-refreshing bearer token (`src/oura/client.ts` + `src/oura/sync.ts`).

## Setup

### 1. Prerequisites
- Node.js 20+.
- A Telegram account, an Anthropic API key, and (optional) an active **Oura Membership** (required for Oura API access).

### 2. Create the Telegram bot
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the **bot token**.
2. Find your **numeric Telegram user id**: message **@userinfobot** (it replies with your id), or **@RawDataBot**. This locks the bot to you alone; everyone else is silently ignored.

### 3. (Optional) Create an Oura API app
1. Go to <https://cloud.ouraring.com/oauth/applications> and create a new application.
2. Set the **Redirect URI** to exactly `http://localhost:3000/oura/callback` (must match `OURA_REDIRECT_URI`).
3. Copy the **Client ID** and **Client Secret**.
4. The OAuth callback port (`OAUTH_HTTP_PORT`, default 3000) must be reachable from the browser you authorize in. For a remote host, port-forward or tunnel it for the one-time `/oura_connect`.

### 4. Configure env
```bash
cp .env.example .env
# then fill in:
#   TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, ALLOWED_TELEGRAM_USER_ID
#   (optional) OURA_CLIENT_ID, OURA_CLIENT_SECRET
```

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From BotFather. |
| `ANTHROPIC_API_KEY` | Anthropic API key. |
| `ALLOWED_TELEGRAM_USER_ID` | Your numeric Telegram id; the only allowed sender. |
| `DB_PATH` | SQLite file (default `./data/lifelog.db`). |
| `FILE_DIR` | Where photos/PDFs are saved (default `./data/files`). |
| `TZ` | Timezone for all timestamps (default `America/New_York`). |
| `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET` | Oura OAuth app credentials. |
| `OURA_REDIRECT_URI` | Must match the Oura app's redirect URI. |
| `OAUTH_HTTP_PORT` | Port for the OAuth callback server. |

### 5. Install, migrate, build, run
```bash
npm install
npm run db:generate     # generate the SQLite migration from the schema
npm run build           # compile TypeScript → dist/
npm start               # node dist/index.js  (migrations auto-run on boot)
```

Run under pm2 for production:
```bash
pm2 start dist/index.js --name lifelog
pm2 logs lifelog
pm2 save
```

For local development: `npm run dev` (tsx watch).

## Connecting Oura

In Telegram, send **`/oura_connect`**. The bot replies with an authorize URL — open it, approve, and you'll see a success page. Tokens are stored and refreshed automatically (refresh-token rotation), so you authorize only once. A nightly pull runs at **09:00 local**; send **`/sync`** to pull immediately.

Pulled streams become `wearable` entries: `oura_sleep` (total sleep, efficiency, latency, stages, HRV, HR), `oura_activity` (steps, calories), `oura_readiness` (score, HRV balance, resting HR, **body-temperature deviation**).

## Using the bot

| Input | What happens |
|---|---|
| Plain text | Parsed into one or more structured entries. |
| Photo (selfie) | Vision analysis → `appearance` entry with facial-bloating score + delta vs your last photo. |
| Document (lab PDF/image) | Bloodwork extraction → `biomarker` entries + flattened `biomarkers` rows with flags. Other files → stored + noted. |
| `/start` | How-to + the two scientific caveats. |
| `/today` | Today's entries grouped by category. |
| `/recent [n]` | Last n entries (default 10). |
| `/stats` | Counts, date range, last weight, 7-day avg Oura sleep, last readiness, recent biomarker flags. |
| `/labs` | Latest bloodwork by panel with out-of-range flags and trend arrows vs the previous draw. |
| `/analyze [question]` | On-demand correlation analysis (Opus). |
| `/bloat` | Pre-focused facial-bloating investigation. |
| `/oura_connect` | Start the one-time Oura OAuth flow. |
| `/sync` | Force an immediate Oura pull. |
| `/reprocess [id]` | Re-run the right analyzer on a stored message (no id → all failed). |
| `/export` | Full JSON dump (messages + entries + biomarkers) as a Telegram document. |
| `/undo` | Delete the most recent message's derived entries (raw kept). |

### Example messages
- `slept on the 21st floor in Philly, woke groggy` → `sleep` entry (floor 21, location Philadelphia, quality groggy).
- `had a latte and bagel at 8am` → `food` entry, event_time 08:00 local.
- `took melatonin, collagen, wore red light glasses, watched the projector` → multiple `routine` entries.
- `5 beers tonight` → `food` entry, alcohol true, alcoholUnits 5.

## Two scientific caveats (surfaced in `/start` and `/bloat`)
1. **Selfie consistency.** A single photo's bloat score is swayed by lighting, angle, time of day, and lens. The score is only meaningful as a *trend across consistent photos*, not as a one-off measurement.
2. **Delayed onset.** Facial bloating is analyzed as dose-and-recovery (looking back 1/3/7 days), not same-day.

> LifeLog is a personal tracking tool, not a medical device. It is not a physician and does not diagnose. Anything concerning warrants a doctor.

## Project layout
```
src/
  index.ts          boot: db, bot, scheduler, http, graceful shutdown
  config.ts         env load + zod validation, model/token constants
  bot.ts            grammy: handlers, commands, auth guard
  http.ts           hono: Oura OAuth callback
  scheduler.ts      node-cron: nightly Oura pull
  db/               drizzle schema + better-sqlite3 client (migrate on boot)
  llm/              parser, vision, bloodwork, analyzer, prompts, anthropic client
  oura/             OAuth client (token refresh) + nightly sync
  services/         ingest (raw-first storage + dispatch), queries
  util/             tz-aware time, 4096-char chunking, file download/encoding
drizzle/            generated migrations
data/               db + files (gitignored)
```
