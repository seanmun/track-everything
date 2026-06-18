import { config } from "./config.js";
import { runMigrations, closeDb } from "./db/client.js";
import { ensureFileDir } from "./util/files.js";
import { createBot, BOT_COMMANDS } from "./bot.js";
import { startHttpServer } from "./http.js";
import { startScheduler } from "./scheduler.js";
import { startReminders } from "./reminders.js";

async function main(): Promise<void> {
  console.log("[boot] LifeLog starting…");

  // 1. Storage prerequisites.
  ensureFileDir();
  runMigrations();
  console.log("[boot] migrations applied, file dir ready.");

  // 2. Subsystems.
  const httpServer = startHttpServer();
  const scheduler = startScheduler();
  const bot = createBot();
  const reminderTasks = startReminders(bot);

  await bot.api.setMyCommands(BOT_COMMANDS).catch(() => {
    /* non-fatal */
  });

  // 3. Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, stopping…`);
    try {
      scheduler.stop();
      for (const t of reminderTasks) t.stop();
      await bot.stop();
      httpServer.close();
      closeDb();
    } catch (err) {
      console.error("[shutdown] error:", err);
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // 4. Start the bot (long-polling). This resolves when the bot stops.
  console.log(`[boot] allowed user ${config.ALLOWED_TELEGRAM_USER_ID}; starting bot…`);
  await bot.start({
    onStart: (info) => console.log(`[boot] bot online as @${info.username}`),
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
