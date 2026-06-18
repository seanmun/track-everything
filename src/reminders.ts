import cron from "node-cron";
import type { Bot } from "grammy";
import { config } from "./config.js";

interface Reminder {
  /** cron expression in the configured timezone */
  cron: string;
  text: string;
}

/**
 * Daily nudges sent to the single allowed user. Times are in config.TZ.
 * Edit freely — these are personal defaults.
 */
const REMINDERS: Reminder[] = [
  { cron: "0 8 * * *", text: "📸 Morning selfie time. Same spot, same light, same angle as always — that's what makes the bloat trend meaningful." },
  { cron: "5 8 * * *", text: "⚖️ Weigh-in: reply with e.g. \"weight 178 lbs\"." },
  { cron: "10 8 * * *", text: "🧠 How do you feel this morning? e.g. \"mood good, energetic\" or \"groggy and puffy, 4/10\"." },
  { cron: "30 12 * * *", text: "🍽️ Lunch log — what did you eat/drink? Don't forget alcohol." },
  { cron: "0 19 * * *", text: "🍽️ Dinner log — foods + any drinks (count the beers)." },
  { cron: "0 21 * * *", text: "🌙 Bedtime routine: melatonin, collagen, magnesium, red-light glasses, screen type, grounding? Log whatever you did." },
  { cron: "30 21 * * *", text: "🧠 Evening check-in: how's your mood, energy, and any bloat right now?" },
];

/** Schedule all reminders. A send failure must never crash the process. */
export function startReminders(bot: Bot): cron.ScheduledTask[] {
  const tasks = REMINDERS.map((r) =>
    cron.schedule(
      r.cron,
      async () => {
        try {
          await bot.api.sendMessage(config.ALLOWED_TELEGRAM_USER_ID, r.text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[reminders] failed to send (${r.cron}): ${msg}`);
        }
      },
      { timezone: config.TZ },
    ),
  );
  console.log(`[reminders] scheduled ${tasks.length} daily reminders (${config.TZ}).`);
  return tasks;
}
