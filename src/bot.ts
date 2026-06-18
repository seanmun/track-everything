import { Bot, InputFile, InlineKeyboard, type Context } from "grammy";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { toZonedIso } from "./util/time.js";
import { chunkMessage } from "./util/chunk.js";
import { localPathFor, downloadToFile, classifyFile, type FileKind } from "./util/files.js";
import { ingestText, ingestPhoto, ingestDocument, reprocess, undoLast } from "./services/ingest.js";
import {
  todayReport,
  recentReport,
  statsReport,
  labsReport,
  exportJson,
} from "./services/queries.js";
import { runAnalysis } from "./llm/analyzer.js";
import { buildAuthorizeUrl, isConnected } from "./oura/client.js";
import { syncOura } from "./oura/sync.js";

const START_TEXT = `LifeLog — your personal health data lake.

Just talk to me:
• Text → I parse it into structured entries (food, sleep, mood, routines, environment…). "5 beers tonight", "slept on the 21st floor in Philly, woke groggy", "took melatonin and collagen".
• Photo (selfie) → I analyze facial bloating, skin tone, under-eye puffiness, and compare to your last photo.
• Document (lab PDF/image) → I extract every biomarker with reference ranges and flags.

Wearable data (sleep, steps, HRV, readiness, body temp) pulls automatically from Oura nightly — run /oura_connect once to link it.

Commands: /today /recent /stats /labs /analyze /bloat /sync /oura_connect /reprocess /export /undo

Two scientific notes:
1) A single selfie's bloat score is swayed by lighting, angle, and time of day. Take selfies in consistent conditions — the score only means something as a *trend*.
2) Facial bloating is treated as delayed-onset (dose-and-recovery), not same-day. /bloat looks back days for triggers.`;

const BLOAT_QUESTION = `Run the full facial-bloating investigation: build a dated bloat timeline (user severity + vision faceBloatingScore), inventory candidate triggers in the 1/3/7 days before each high-bloat day (alcohol units, dairy/specific foods, sodium, poor sleep, low HRV/readiness, elevated body-temp deviation, late screens, skipped grounding), estimate lag and recovery duration, explicitly answer whether ~5 beers tracks with multi-day bloat and how many days it takes to resolve, whether dairy tracks with bloat and at what lag, cross-reference biomarkers, compare good vs bad weeks, and propose a concrete elimination test.`;

const HELP_TEXT = `LifeLog commands:

Logging
• Just send text — I parse it into entries.
• Send a selfie — vision bloat/skin analysis.
• Send a lab PDF/photo — biomarker extraction.
• /log — tap a category for a fill-in template.

Views
• /today — today's entries
• /recent [n] — last n entries (default 10)
• /stats — counts, last weight, sleep avg, flags
• /labs — latest bloodwork + trends

Analysis
• /analyze [question] — correlations
• /bloat — facial-bloating investigation

Oura
• /oura_connect — link Oura (one time)
• /sync — pull Oura now

Data
• /reprocess [id] — re-run analysis on a message
• /export — full JSON dump
• /undo — remove last message's entries

You'll also get daily reminders (selfie, weigh-in, meals, mood, bedtime).`;

// Tap-to-log fill-in templates. The callback data is `log:<key>`.
const LOG_TEMPLATES: Record<string, { label: string; template: string }> = {
  food: {
    label: "🍽️ Food / drink",
    template: `Copy & edit, then send:\n"latte and a bagel at 8am"\n"chicken, rice, broccoli for dinner ~7pm"\n"5 beers tonight"  (always count the drinks)`,
  },
  mood: {
    label: "🧠 How I feel",
    template: `Copy & edit, then send:\n"mood good, energetic, 8/10"\n"anxious and tired, 4/10"`,
  },
  sleep: {
    label: "😴 Sleep",
    template: `Copy & edit, then send:\n"slept ~6h, restless, woke groggy"\n"slept on the 21st floor in Philly"  (Oura fills the numbers)`,
  },
  weight: {
    label: "⚖️ Weight",
    template: `Copy & edit, then send:\n"weight 178 lbs"`,
  },
  appearance: {
    label: "📸 Appearance / bloat",
    template: `Best: send a selfie photo (same light/angle each time).\nOr describe:\n"face feels puffy, 6/10"\n"under-eyes swollen this morning"`,
  },
  exercise: {
    label: "🏃 Exercise",
    template: `Copy & edit, then send:\n"ran 30 min easy"\n"upper-body lift, 45 min, hard"`,
  },
  routine: {
    label: "🌙 Routine / supplements",
    template: `Copy & edit, then send:\n"took melatonin, collagen, magnesium"\n"wore red-light glasses, watched the projector"`,
  },
  environment: {
    label: "🌍 Environment",
    template: `Copy & edit, then send:\n"slept grounded, EMF off, windows open"\n"high humidity today"`,
  },
  note: {
    label: "📝 Note",
    template: `Copy & edit, then send:\nanything else worth recording`,
  },
};

function logKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  const keys = Object.keys(LOG_TEMPLATES);
  keys.forEach((key, i) => {
    kb.text(LOG_TEMPLATES[key]!.label, `log:${key}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

export function createBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // --- Auth guard: only the allowed user; everyone else is ignored silently.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.ALLOWED_TELEGRAM_USER_ID) return; // no response
    await next();
  });

  // --- Commands ---
  bot.command("start", (ctx) => reply(ctx, START_TEXT));
  bot.command("help", (ctx) => reply(ctx, HELP_TEXT));
  bot.command("log", (ctx) =>
    ctx.reply("What do you want to log? Tap a category for a fill-in template:", {
      reply_markup: logKeyboard(),
    }),
  );
  bot.callbackQuery(/^log:(.+)$/, async (ctx) => {
    const key = ctx.match[1]!;
    const entry = LOG_TEMPLATES[key];
    await ctx.answerCallbackQuery();
    await reply(ctx, entry ? entry.template : "Unknown category.");
  });
  bot.command("today", (ctx) => reply(ctx, todayReport()));
  bot.command("recent", (ctx) => {
    const n = parseInt((ctx.match ?? "").trim(), 10);
    return reply(ctx, recentReport(Number.isFinite(n) && n > 0 ? n : 10));
  });
  bot.command("stats", (ctx) => reply(ctx, statsReport()));
  bot.command("labs", (ctx) => reply(ctx, labsReport()));

  bot.command("analyze", async (ctx) => {
    const q = (ctx.match ?? "").trim();
    await reply(ctx, "Analyzing… this can take a moment.");
    const report = await runAnalysis(q || undefined);
    await reply(ctx, report);
  });

  bot.command("bloat", async (ctx) => {
    await reply(ctx, "Investigating facial bloating across your history…");
    const report = await runAnalysis(BLOAT_QUESTION);
    await reply(ctx, report);
  });

  bot.command("oura_connect", async (ctx) => {
    if (!config.OURA_CLIENT_ID) {
      return reply(ctx, "Oura is not configured (set OURA_CLIENT_ID / OURA_CLIENT_SECRET in .env).");
    }
    const url = buildAuthorizeUrl(randomUUID());
    await reply(
      ctx,
      `Open this link to authorize Oura (one time):\n${url}\n\nAfter you approve, you'll see a success page and nightly pulls will begin.`,
    );
  });

  bot.command("sync", async (ctx) => {
    if (!isConnected()) return reply(ctx, "Oura isn't connected. Run /oura_connect first.");
    await reply(ctx, "Pulling from Oura…");
    try {
      const s = await syncOura();
      await reply(
        ctx,
        `Oura sync done. Sleep: ${s.sleep}, activity: ${s.activity}, readiness: ${s.readiness}. Days: ${s.days.join(", ") || "none"}.`,
      );
    } catch (err) {
      await reply(ctx, `Oura sync failed: ${errMsg(err)}`);
    }
  });

  bot.command("reprocess", async (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const id = arg ? parseInt(arg, 10) : undefined;
    await reply(ctx, "Reprocessing…");
    const result = await reprocess(Number.isFinite(id) ? id : undefined);
    await reply(ctx, result);
  });

  bot.command("export", async (ctx) => {
    const json = exportJson();
    const buf = Buffer.from(json, "utf-8");
    await ctx.replyWithDocument(new InputFile(buf, "lifelog-export.json"));
  });

  bot.command("undo", (ctx) => reply(ctx, undoLast()));

  // --- Photo (vision) ---
  bot.on("message:photo", async (ctx) => {
    try {
      const photos = ctx.msg.photo;
      const largest = photos[photos.length - 1]!;
      const filePath = await downloadTelegramFile(ctx, largest.file_unique_id);
      const result = await ingestPhoto({
        telegramMessageId: ctx.msg.message_id,
        filePath,
        caption: ctx.msg.caption,
        messageTimeIso: messageTime(ctx),
      });
      await reply(ctx, result);
    } catch (err) {
      await reply(ctx, `Failed to handle photo: ${errMsg(err)}`);
    }
  });

  // --- Document (bloodwork or note) ---
  bot.on("message:document", async (ctx) => {
    try {
      const doc = ctx.msg.document;
      const kind: FileKind = classifyFile(doc.mime_type, doc.file_name);
      const filePath = await downloadTelegramFile(ctx, doc.file_unique_id);
      const result = await ingestDocument({
        telegramMessageId: ctx.msg.message_id,
        filePath,
        fileKind: kind,
        fileName: doc.file_name,
        caption: ctx.msg.caption,
        messageTimeIso: messageTime(ctx),
      });
      await reply(ctx, result);
    } catch (err) {
      await reply(ctx, `Failed to handle document: ${errMsg(err)}`);
    }
  });

  // --- Plain text (must be after commands) ---
  bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    if (text.startsWith("/")) return; // unknown command; ignore quietly
    try {
      const result = await ingestText({
        telegramMessageId: ctx.msg.message_id,
        text,
        messageTimeIso: messageTime(ctx),
      });
      await reply(ctx, result);
    } catch (err) {
      await reply(ctx, `Something went wrong, but your message is stored. ${errMsg(err)}`);
    }
  });

  bot.catch((err) => {
    console.error("[bot] unhandled error:", err.error);
  });

  return bot;
}

async function downloadTelegramFile(ctx: Context, fileUniqueId: string): Promise<string> {
  const file = await ctx.getFile(); // works for photo/document in the current update
  const remotePath = file.file_path ?? "";
  const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${remotePath}`;
  const dest = localPathFor(remotePath, fileUniqueId);
  await downloadToFile(url, dest);
  return dest;
}

function messageTime(ctx: Context): string {
  const unix = ctx.msg?.date ?? Math.floor(Date.now() / 1000);
  return toZonedIso(unix * 1000);
}

async function reply(ctx: Context, text: string): Promise<void> {
  for (const chunk of chunkMessage(text)) {
    await ctx.reply(chunk);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const BOT_COMMANDS = [
  { command: "start", description: "How to use LifeLog" },
  { command: "help", description: "List all commands" },
  { command: "log", description: "Guided log with category buttons" },
  { command: "today", description: "Today's entries" },
  { command: "recent", description: "Recent entries [n]" },
  { command: "stats", description: "Summary stats" },
  { command: "labs", description: "Latest bloodwork" },
  { command: "analyze", description: "Correlation analysis [question]" },
  { command: "bloat", description: "Facial-bloating investigation" },
  { command: "sync", description: "Force an Oura pull" },
  { command: "oura_connect", description: "Link your Oura account" },
  { command: "reprocess", description: "Re-run analysis on a message [id]" },
  { command: "export", description: "Export all data as JSON" },
  { command: "undo", description: "Undo the last message's entries" },
];
