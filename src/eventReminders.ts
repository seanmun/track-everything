import cron from "node-cron";
import type { Bot } from "grammy";
import { config } from "./config.js";
import {
  dueReminders,
  staleReminders,
  markReminded,
  todaysEvents,
  formatEvent,
} from "./services/events.js";
import type { Event } from "./db/schema.js";

/**
 * Fires event reminders (per-event, dynamic) and a morning agenda.
 * A send failure must never crash the loop.
 */
export function startEventReminders(bot: Bot): cron.ScheduledTask[] {
  const send = async (text: string): Promise<void> => {
    try {
      await bot.api.sendMessage(config.ALLOWED_TELEGRAM_USER_ID, text);
    } catch (err) {
      console.error(`[events] send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Every minute: deliver due reminders; silently retire missed ones.
  const reminderTask = cron.schedule(
    "* * * * *",
    async () => {
      for (const e of staleReminders()) markReminded(e.id);
      for (const e of dueReminders()) {
        await send(`⏰ Reminder: ${formatEvent(e)}`);
        markReminded(e.id);
      }
    },
    { timezone: config.TZ },
  );

  // 07:30 local: today's agenda, if any.
  const agendaTask = cron.schedule(
    "30 7 * * *",
    async () => {
      const today: Event[] = todaysEvents();
      if (today.length === 0) return;
      const lines = today.map((e) => `• ${formatEvent(e)}`);
      await send(`🗓️ Today's schedule:\n${lines.join("\n")}`);
    },
    { timezone: config.TZ },
  );

  console.log(`[events] event reminders + morning agenda scheduled (${config.TZ}).`);
  return [reminderTask, agendaTask];
}
