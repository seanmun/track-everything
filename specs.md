# LifeLog — Technical Specification (v2)

A single-user **personal health data lake**. Telegram is the fast manual-input pipe; wearable and file data are pulled/ingested automatically. An LLM parses everything into structured, timestamped entries in one database. Computer vision analyzes uploaded photos. Bloodwork PDFs/images become structured biomarker time-series. On-demand analysis surfaces trends and correlations — above all, the cause of the user's episodic facial bloating.

**Build target:** One-shot Claude Code build. This spec is the single source of truth. Every decision is made here. Do not add unlisted features; do not ask clarifying questions mid-build.

---

## 1. Philosophy & Hard Rules

1. **Single user.** No auth beyond a hardcoded allowed Telegram user ID. Reject everyone else silently.
2. **Capture everything, lose nothing.** Every inbound message, photo, file, and API pull is stored raw/verbatim before any processing. Parsed/derived data is a separate layer that can always be rebuilt from raw.
3. **Pull what can be pulled; type only what can't.** Sleep, steps, HRV, readiness, body temp come from the wearable automatically. The user only manually logs what no device captures (food, alcohol, mood, bloat, routines, environment).
4. **Idempotent timestamps.** User-stated time wins; otherwise the source timestamp (Telegram message time, Oura day, bloodwork draw date). Always store both effective `event_time` and the raw source time.
5. **Flexible schema.** Common dimensions = typed JSON shapes; novel things go in free `data` without migrations.
6. **Analysis is on-demand**, never automatic, except the nightly wearable pull (which is ingestion, not analysis).

---

## 2. System Architecture

One codebase, one SQLite database, one `pm2` process running three subsystems:

```
                         ┌──────────────────────────┐
  Telegram  ──text/photo─▶│  1. Ingest Bot (grammy)  │
  /file/cmd              │                          │
                         │  2. Scheduler (node-cron)│──nightly──▶ Oura API v2
  Oura Cloud ◀───OAuth───┤     + OAuth callback     │
                         │     (tiny HTTP server)   │
                         │  3. Analyzers (LLM/vision)│
                         └────────────┬─────────────┘
                                      │
                              ┌───────▼────────┐
                              │  SQLite (one)  │
                              └────────────────┘
```

- **Ingest Bot** — handles text, photos, and document uploads from Telegram.
- **Scheduler** — `node-cron` job pulls Oura nightly; a minimal HTTP server (`hono`) hosts the one-time OAuth callback and stores/refreshes tokens.
- **Analyzers** — parser, vision analyzer, bloodwork extractor, and the correlation analysis engine. All Anthropic API.

---

## 3. Stack (fixed — do not substitute)

| Layer | Choice |
|---|---|
| Language | TypeScript (strict) |
| Runtime | Node.js 20+ |
| Telegram | `grammy` |
| Database | SQLite via `better-sqlite3` |
| ORM/Migrations | `drizzle-orm` + `drizzle-kit` |
| LLM + Vision | Anthropic API (`@anthropic-ai/sdk`) — vision via image content blocks |
| Wearable | Oura API v2 via `oura_api` (npm) |
| Scheduler | `node-cron` |
| HTTP (OAuth callback) | `hono` |
| File storage | local `./data/files/` (images, PDFs) — path referenced from DB |
| Validation | `zod` |
| Process mgr | `pm2` (documented) |

**Models:** parsing `claude-sonnet-4-6`; vision + bloodwork extraction `claude-sonnet-4-6`; correlation analysis `claude-opus-4-8`.

---

## 4. Environment Variables (`.env`)

```
TELEGRAM_BOT_TOKEN=
ANTHROPIC_API_KEY=
ALLOWED_TELEGRAM_USER_ID=
DB_PATH=./data/lifelog.db
FILE_DIR=./data/files
TZ=America/New_York
# Oura OAuth
OURA_CLIENT_ID=
OURA_CLIENT_SECRET=
OURA_REDIRECT_URI=http://localhost:3000/oura/callback
OAUTH_HTTP_PORT=3000
```

---

## 5. Database Schema (Drizzle, SQLite)

### Table: `messages` — raw inbound record (lossless)
| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `source` | text | `telegram_text`, `telegram_photo`, `telegram_file`, `oura`, `system` |
| `telegram_message_id` | int nullable | |
| `raw_text` | text nullable | verbatim text/caption |
| `file_path` | text nullable | local path if a photo/file was attached |
| `file_kind` | text nullable | `image`, `pdf`, `other` |
| `message_time` | text ISO | source timestamp |
| `parse_status` | text | `ok`, `failed`, `empty`, `pending` |
| `parse_error` | text nullable | |
| `llm_raw_response` | text nullable | raw model output, for reprocessing |
| `created_at` | text ISO | |

### Table: `entries` — derived structured log
| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `message_id` | int FK→messages | nullable for Oura-derived rows that batch many days |
| `category` | text | `food`, `sleep`, `weight`, `mood`, `appearance`, `exercise`, `environment`, `routine`, `wearable`, `biomarker`, `note` |
| `subtype` | text nullable | e.g. `oura_sleep`, `oura_activity`, `oura_readiness`, biomarker name |
| `event_time` | text ISO | effective time |
| `summary` | text | one-line human-readable |
| `data` | text JSON | category-specific structured fields (§7) |
| `source` | text | `manual`, `oura`, `vision`, `bloodwork` |
| `created_at` | text ISO | |

### Table: `oura_tokens` — wearable auth
| Column | Type | Notes |
|---|---|---|
| `id` | int PK (always 1) | single row |
| `access_token` | text | |
| `refresh_token` | text | |
| `expires_at` | text ISO | |
| `updated_at` | text ISO | |

### Table: `biomarkers` — normalized lab results for trend math
Derived from `biomarker` entries but flattened for easy time-series queries.
| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `entry_id` | int FK→entries | |
| `name` | text | normalized, e.g. `vitamin_d`, `tsh`, `crp`, `alt`, `glucose` |
| `value` | real | |
| `unit` | text | |
| `ref_low` | real nullable | reference range low |
| `ref_high` | real nullable | reference range high |
| `flag` | text nullable | `low`/`normal`/`high` if determinable |
| `drawn_at` | text ISO | blood draw date (user-stated or from the report) |

A reprocess command can rebuild `entries` (and `biomarkers`) from any `messages` row.

---

## 6. Ingestion Flows

### 6a. Text message
Verify sender → store raw `messages` row immediately → call Parser (§7) → insert `entries` → confirm with per-entry summaries. On parse failure, keep raw, tell user it's safe.

### 6b. Photo (computer-vision analysis)
1. Verify sender. Download the photo to `FILE_DIR`, store a `messages` row (`source=telegram_photo`, `file_path`, caption as `raw_text`).
2. Call the **Vision Analyzer** (§8) with the image + caption.
3. Insert an `appearance` entry (source `vision`) with the model's structured observations, plus any explicit user caption claims.
4. Reply with what vision detected (facial puffiness estimate, skin tone/redness, under-eye, visible bloat) and how it compares to the user's most recent prior selfie if one exists.

### 6c. Document upload (bloodwork etc.)
1. Verify sender. Save file to `FILE_DIR`, store `messages` row (`source=telegram_file`, `file_kind`).
2. If PDF or image of labs → call the **Bloodwork Extractor** (§9): produce one `biomarker` entry per panel plus flattened `biomarkers` rows. Draw date from the report, or from the user's caption ("bloodwork from March 2024"), or message time as last resort.
3. Reply summarizing extracted markers and flagging any out-of-range values.
4. Non-lab files → store, create a `note` entry referencing the file.

### 6d. Oura nightly pull (scheduler)
1. `node-cron` runs daily at 09:00 local (after sleep data finalizes).
2. Refresh the access token if `expires_at` is near; persist new tokens to `oura_tokens`.
3. Pull yesterday's (and any missing recent days') `daily_sleep`, `sleep`, `daily_activity` (steps), `daily_readiness`, heart rate. Upsert as `wearable` entries (`subtype` per stream, source `oura`), keyed by day so re-runs don't duplicate.
4. No Telegram message on success unless the user runs `/sync`.

---

## 7. The Parser (LLM call — text)

`claude-sonnet-4-6`, temp 0, strict JSON, zod-validated, one retry on bad JSON.

System prompt intent:
> You are a life-tracking data parser for a single user living in Pennsylvania (timezone America/New_York). You receive a free-text message describing one or more things the user did, ate, felt, measured, or observed. Decompose it into one or more structured entries. The message was received at {message_time_iso}. For each entry determine event_time: if the message states/implies a time, resolve to absolute ISO 8601 in America/New_York; otherwise use the received time. Assign each entry a category. Put any detail that doesn't fit named fields into `data` freely — never discard information. Generate a short `summary`. Return ONLY JSON: { "entries": [ { "category", "event_time", "summary", "data" } ] }.

Category `data` shapes:
- **food**: `{ items: string[], notes?, estimated?: bool, alcohol?: bool, alcoholType?: string, alcoholUnits?: number }` — always quantify alcohol in standard drinks ("five beers"=5).
- **sleep**: `{ hours?, quality?, floor?, location?, notes? }` (manual notes; Oura provides hard numbers).
- **weight**: `{ value, unit }`
- **mood**: `{ mood, intensity?:1-10, notes? }`
- **appearance**: `{ observations: string[], bodyArea?, severity?:1-10, notes? }` — facial bloating primary: bodyArea:"face" + severity.
- **exercise**: `{ activity, durationMin?, intensity?, notes? }`
- **environment**: `{ type, value?, notes? }` — EMF, grounding, floor, sleep location, weather.
- **routine**: `{ type, value?, notes? }` — melatonin, collagen, baking_soda, green_tea, red_light_therapy, red_light_glasses, blue_light_exposure, screen_type (projector/lcd/oled), magnesium, etc. Dose/duration in value/notes.
- **note**: `{ text }`

A single message may yield multiple entries.

---

## 8. Vision Analyzer (LLM call — image)

`claude-sonnet-4-6` with an image content block. Temp 0. Strict JSON.

System prompt intent:
> You are analyzing a self-portrait photo from a user tracking facial bloating and skin/appearance over time. Objectively and clinically describe only what is visible. Return JSON: { faceBloatingScore: 0-10 (puffiness/fluid retention in cheeks, jaw, under-eyes), underEyePuffiness: 0-10, skinTone: "pale"|"normal"|"flushed"|"tanned"|"sunburned", redness: 0-10, blemishes: string[], jawlineDefinition: "sharp"|"moderate"|"soft", otherObservations: string[], confidence: 0-1 }. Judge only from the image; do not guess causes. Note lighting/angle caveats in otherObservations. You are not diagnosing; this is descriptive tracking.

Store as an `appearance` entry, source `vision`. If a prior vision entry exists, include a one-line delta in the reply (e.g. "face bloat 6 vs 3 last photo").

> **Scientific honesty note** (surface in `/start` and the bloat report): a single photo's bloat score is influenced by lighting, angle, time of day, and lens. The score is only meaningful as a *trend across consistent photos* (same lighting/angle/time), not as a one-off measurement. Encourage consistent selfie conditions.

---

## 9. Bloodwork Extractor (LLM call — PDF/image)

`claude-sonnet-4-6` with the document/image as a content block. Temp 0. Strict JSON.

System prompt intent:
> Extract every lab result from this bloodwork report. Return JSON: { drawnAt: ISO date or null, panels: [ { name, markers: [ { name, normalizedName, value, unit, refLow, refHigh, flag } ] } ] }. normalizedName is lowercase snake_case canonical key (e.g. "vitamin_d", "tsh", "hs_crp", "alt", "fasting_glucose", "hba1c", "sodium", "potassium"). flag is low/normal/high vs the printed reference range. If a value/range is unreadable, omit that marker rather than guessing. drawnAt from the report's collection date if present.

Insert one `biomarker` entry (panel summary in `data`) and flatten each marker into `biomarkers`. Reply with extracted markers grouped by panel, out-of-range ones flagged.

---

## 10. Oura Integration

- One-time setup: user runs `/oura_connect`; bot replies with the authorize URL (`hono` server hosts `/oura/callback`). On callback, exchange code → store access+refresh tokens. **Implement refresh-token rotation** so the user authorizes once (tokens otherwise expire ~30 days).
- Requires an active Oura Membership for API access (document in README).
- Base URL `https://api.ouraring.com/v2`. Bearer auth. Exponential backoff on 429 (limit 5000 req / 5 min — trivial here).
- Pulled streams → `wearable` entries: `oura_sleep` (total sleep, efficiency, latency, stages), `oura_activity` (steps, active calories), `oura_readiness` (score, HRV, resting HR, body temperature deviation). Include body-temp deviation — useful inflammation/illness signal.

---

## 11. Bot Commands

| Command | Action |
|---|---|
| (text) | Log it. |
| (photo) | Vision-analyze + log appearance. |
| (document) | Bloodwork extract, or store + note. |
| `/start` | Greeting, how-to, selfie-consistency + photo-science caveat. |
| `/today` | Today's entries grouped by category (incl. Oura). |
| `/recent [n]` | Last n entries (default 10). |
| `/stats` | Counts per category, date range, last weight, 7-day avg sleep (Oura), last readiness, recent biomarker flags. |
| `/labs` | Latest bloodwork by panel with out-of-range flags; trend arrow vs previous draw for repeated markers. |
| `/analyze [question]` | Correlation engine (§12). |
| `/bloat` | Pre-focused facial-bloating investigation (§12). |
| `/oura_connect` | Start the OAuth flow. |
| `/sync` | Force an immediate Oura pull and report what came in. |
| `/reprocess [message_id]` | Re-run the right analyzer on a stored message; rebuild its entries. No id → all `failed`. |
| `/export` | Full JSON dump of messages + entries + biomarkers as a Telegram document. |
| `/undo` | Delete entries from the most recent message (raw kept). |

---

## 12. Analysis Engine (LLM call — analysis)

`claude-opus-4-8`, temp 0.3. Pull all entries (cap ~2000 most recent; aggregate older to daily summaries if exceeded), plus all `biomarkers`. Serialize compactly by date. Chunk replies under Telegram's 4096-char limit.

System prompt intent:
> You are a personal health and lifestyle analyst with a single user's longitudinal data: food (incl. alcohol units), manual + Oura sleep, steps/activity, readiness/HRV/resting-HR/body-temperature deviation, weight, mood, appearance (incl. vision-derived facial bloating scores), exercise, environment (EMF, grounding, floor slept on, location), bedtime routines (melatonin, collagen, baking soda, green tea, red/blue light, screen type), and bloodwork biomarkers over time.
>
> **Primary standing question — facial bloating.** Treat it as delayed-onset, dose-and-recovery, not same-day. Build a timeline of facial bloat (user-reported severity + vision faceBloatingScore). For each high-bloat day, look back 1/3/7 days and inventory candidate triggers: alcohol (units + days prior), dairy and specific foods, high-sodium foods, poor sleep, low HRV / low readiness, elevated body-temperature deviation, late screen exposure, skipped grounding. Estimate lag and recovery duration. Explicitly answer: does a single heavy drinking night (~5 beers) track with multi-day bloat, and over how many days does it resolve? Does dairy track with bloat, at what lag? Cross-reference biomarkers (inflammatory markers, kidney/sodium, thyroid) where relevant. Compare good weeks vs bad weeks: what's systematically present in bad weeks and absent in good ones?
>
> Also surface: foods preceding negative appearance/mood/sleep (possible intolerances, with lag + dates); whether higher sleeping floors track with worse Oura sleep; whether grounding/EMF track with readiness/mood/appearance; which bedtime routines track with better sleep or less bloat; weight and biomarker trends.
>
> Rules: cite specific dates/entries for every finding; separate correlation from causation; state confidence and sample size; propose concrete elimination tests (e.g. "cut dairy 10 days, log face severity + take a daily selfie in identical lighting"); say when data is insufficient rather than inventing patterns; flag anything warranting a doctor. You are not a physician. Lead with the user's question if one was asked.

---

## 13. Project Structure

```
lifelog/
  src/
    index.ts                 # boot: db, bot, scheduler, http server, graceful shutdown
    config.ts                # env load + zod validation
    bot.ts                   # grammy: text/photo/document handlers, commands, auth guard
    http.ts                  # hono server: Oura OAuth callback
    scheduler.ts             # node-cron: nightly Oura pull
    db/
      schema.ts              # drizzle: messages, entries, oura_tokens, biomarkers
      client.ts              # better-sqlite3 + drizzle, migrate on boot
    llm/
      parser.ts              # text -> entries
      vision.ts              # image -> appearance
      bloodwork.ts           # pdf/image -> biomarkers
      analyzer.ts            # correlation report
      prompts.ts
    oura/
      client.ts              # oura_api wrapper, token refresh
      sync.ts                # pull + upsert wearable entries
    services/
      ingest.ts              # raw-first storage + dispatch by source/kind
      queries.ts             # today/recent/stats/labs/export
    util/
      time.ts                # tz-aware resolution
      chunk.ts               # split >4096-char replies
      files.ts               # download + save attachments
  drizzle/
  data/                      # db + files (gitignored)
  .env.example
  package.json
  tsconfig.json
  README.md
```

---

## 14. Non-negotiable Implementation Details

- TypeScript strict; `any` only for JSON passthrough (`Record<string, unknown>`).
- **Store the raw `messages` row (and save any file to disk) BEFORE any LLM/vision/extraction call.** Data-safety guarantee.
- All times ISO 8601 with resolved `America/New_York` offset.
- Anthropic: parse/vision/bloodwork temp 0, analysis temp 0.3. `max_tokens`: parse 4096, vision 2048, bloodwork 4096, analysis 8192. Strip stray markdown fences before `JSON.parse`; retry once with "valid JSON only" on parse error.
- Vision/bloodwork images sent as base64 image content blocks; PDFs as document content blocks (or rasterize-then-image if needed).
- Oura tokens refreshed proactively; never crash the scheduler on a single failed pull — log and continue.
- Migrations auto-run on boot. Graceful shutdown closes DB and HTTP server.
- README documents: BotFather token; finding numeric Telegram user id; creating an Oura API app + client id/secret + redirect URI; Oura Membership requirement; `.env`; `npm run db:generate`, `npm run build`, `pm2 start dist/index.js --name lifelog`; and that the OAuth callback port must be reachable for the one-time `/oura_connect`.

---

## 15. Acceptance Criteria

1. "slept on the 21st floor in Philly, woke groggy" → `sleep` entry (floor 21, location Philadelphia, quality groggy); Oura supplies numeric hours separately.
2. "had a latte and bagel at 8am" → `food` entry, event_time 8:00 local.
3. "took melatonin, collagen, wore red light glasses, watched the projector" → multiple `routine` entries.
4. "5 beers tonight" → `food` entry with alcohol true, alcoholUnits 5.
5. Sending a selfie → `appearance` entry (source vision) with faceBloatingScore + skinTone, and a delta vs the previous selfie.
6. Uploading a bloodwork PDF → `biomarker` entry + flattened `biomarkers` rows with flags; `/labs` shows them with trend arrows vs prior draw.
7. `/oura_connect` then authorizing → tokens stored; nightly pull creates `wearable` entries; `/sync` reports them.
8. `/bloat` → dated report inventorying pre-bloat windows, naming suspected triggers with lag + recovery, cross-referencing Oura body-temp/HRV and biomarkers, comparing good vs bad weeks, proposing an elimination test.
9. Any unparseable message/file is still stored and the user told it's safe.
10. `/export` returns complete JSON of all data.
11. Non-allowed user gets no response.