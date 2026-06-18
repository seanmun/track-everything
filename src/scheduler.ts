import cron from "node-cron";
import { config } from "./config.js";
import { isConnected } from "./oura/client.js";
import { syncOura } from "./oura/sync.js";

/**
 * Nightly Oura pull at 09:00 local (after sleep data finalizes). A single
 * failed pull must never crash the scheduler — log and continue.
 */
export function startScheduler(): cron.ScheduledTask {
  const task = cron.schedule(
    "0 9 * * *",
    async () => {
      if (!isConnected()) {
        console.log("[scheduler] Oura not connected; skipping nightly pull.");
        return;
      }
      try {
        const s = await syncOura();
        console.log(
          `[scheduler] Oura pull ok — sleep:${s.sleep} activity:${s.activity} readiness:${s.readiness} days:${s.days.join(",")}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] Oura pull failed (continuing): ${msg}`);
      }
    },
    { timezone: config.TZ },
  );

  console.log(`[scheduler] nightly Oura pull scheduled for 09:00 ${config.TZ}`);
  return task;
}
