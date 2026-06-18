import { and, eq, like } from "drizzle-orm";
import { db } from "../db/client.js";
import { entries } from "../db/schema.js";
import { getValidAccessToken, OURA_API_BASE } from "./client.js";
import { nowIso, daysAgoKey } from "../util/time.js";

interface OuraDoc {
  id?: string;
  day?: string;
  [key: string]: unknown;
}

interface SyncSummary {
  sleep: number;
  activity: number;
  readiness: number;
  days: string[];
}

/** Pull a trailing window from Oura and upsert wearable entries (idempotent). */
export async function syncOura(windowDays = 14): Promise<SyncSummary> {
  const token = await getValidAccessToken();
  const startDate = daysAgoKey(windowDays);
  // end_date is exclusive of "today" in some Oura endpoints; pad to tomorrow.
  const endDate = daysAgoKey(-1);

  const [dailySleep, sleepDocs, dailyActivity, dailyReadiness] = await Promise.all([
    fetchCollection(token, "daily_sleep", startDate, endDate),
    fetchCollection(token, "sleep", startDate, endDate),
    fetchCollection(token, "daily_activity", startDate, endDate),
    fetchCollection(token, "daily_readiness", startDate, endDate),
  ]);

  const touchedDays = new Set<string>();
  const summary: SyncSummary = { sleep: 0, activity: 0, readiness: 0, days: [] };

  // --- Sleep: merge daily_sleep (score) with the long sleep period per day ---
  const dailySleepByDay = indexByDay(dailySleep);
  const longSleepByDay = pickLongestSleepPerDay(sleepDocs);
  for (const day of unionDays(dailySleepByDay, longSleepByDay)) {
    const ds = dailySleepByDay.get(day);
    const sp = longSleepByDay.get(day);
    const total = num(sp?.total_sleep_duration);
    const data = {
      score: num(ds?.score),
      totalSleepHours: total != null ? round(total / 3600, 2) : null,
      efficiency: num(sp?.efficiency),
      latencySec: num(sp?.latency),
      stagesSec: {
        deep: num(sp?.deep_sleep_duration),
        rem: num(sp?.rem_sleep_duration),
        light: num(sp?.light_sleep_duration),
        awake: num(sp?.awake_time),
      },
      averageHrv: num(sp?.average_hrv),
      averageHeartRate: num(sp?.average_heart_rate),
      lowestHeartRate: num(sp?.lowest_heart_rate),
      raw: { daily_sleep: ds ?? null, sleep: sp ?? null },
    };
    upsertWearable(day, "oura_sleep", `Oura sleep ${day}: ${data.totalSleepHours ?? "?"}h, score ${data.score ?? "?"}`, data);
    summary.sleep++;
    touchedDays.add(day);
  }

  // --- Activity: steps + calories ---
  for (const doc of dailyActivity) {
    const day = doc.day;
    if (!day) continue;
    const data = {
      score: num(doc.score),
      steps: num(doc.steps),
      activeCalories: num(doc.active_calories),
      totalCalories: num(doc.total_calories),
      raw: doc,
    };
    upsertWearable(day, "oura_activity", `Oura activity ${day}: ${data.steps ?? "?"} steps, score ${data.score ?? "?"}`, data);
    summary.activity++;
    touchedDays.add(day);
  }

  // --- Readiness: score, HRV balance, resting HR, body-temp deviation ---
  for (const doc of dailyReadiness) {
    const day = doc.day;
    if (!day) continue;
    const contributors = (doc.contributors as Record<string, unknown> | undefined) ?? {};
    const data = {
      score: num(doc.score),
      temperatureDeviation: num(doc.temperature_deviation),
      temperatureTrendDeviation: num(doc.temperature_trend_deviation),
      hrvBalance: num(contributors.hrv_balance),
      restingHeartRate: num(contributors.resting_heart_rate),
      bodyTemperature: num(contributors.body_temperature),
      raw: doc,
    };
    upsertWearable(
      day,
      "oura_readiness",
      `Oura readiness ${day}: score ${data.score ?? "?"}, tempΔ ${data.temperatureDeviation ?? "?"}`,
      data,
    );
    summary.readiness++;
    touchedDays.add(day);
  }

  summary.days = [...touchedDays].sort();
  return summary;
}

/** Delete any existing same-day/same-subtype wearable row, then insert. */
function upsertWearable(day: string, subtype: string, summary: string, data: unknown): void {
  const eventTime = `${day}T12:00:00`;
  db.delete(entries)
    .where(
      and(
        eq(entries.category, "wearable"),
        eq(entries.subtype, subtype),
        like(entries.eventTime, `${day}%`),
      ),
    )
    .run();
  db.insert(entries)
    .values({
      messageId: null,
      category: "wearable",
      subtype,
      eventTime,
      summary,
      data: JSON.stringify(data),
      source: "oura",
      createdAt: nowIso(),
    })
    .run();
}

async function fetchCollection(
  token: string,
  endpoint: string,
  startDate: string,
  endDate: string,
): Promise<OuraDoc[]> {
  const out: OuraDoc[] = [];
  let nextToken: string | undefined;

  do {
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
    if (nextToken) params.set("next_token", nextToken);
    const url = `${OURA_API_BASE}/usercollection/${endpoint}?${params.toString()}`;

    const res = await fetchWithBackoff(url, token);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Oura ${endpoint} failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { data?: OuraDoc[]; next_token?: string | null };
    if (Array.isArray(json.data)) out.push(...json.data);
    nextToken = json.next_token ?? undefined;
  } while (nextToken);

  return out;
}

/** GET with exponential backoff on HTTP 429. */
async function fetchWithBackoff(url: string, token: string, maxAttempts = 5): Promise<Response> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status !== 429 || attempt >= maxAttempts - 1) return res;
    const waitMs = Math.min(30_000, 1000 * 2 ** attempt);
    await delay(waitMs);
    attempt++;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function indexByDay(docs: OuraDoc[]): Map<string, OuraDoc> {
  const map = new Map<string, OuraDoc>();
  for (const d of docs) if (d.day) map.set(d.day, d);
  return map;
}

/** Choose the longest sleep period per day (the main nightly sleep). */
function pickLongestSleepPerDay(docs: OuraDoc[]): Map<string, OuraDoc> {
  const map = new Map<string, OuraDoc>();
  for (const d of docs) {
    if (!d.day) continue;
    const existing = map.get(d.day);
    const candidateDur = num(d.total_sleep_duration) ?? 0;
    const existingDur = existing ? num(existing.total_sleep_duration) ?? 0 : -1;
    if (!existing || candidateDur > existingDur) {
      map.set(d.day, d);
    }
  }
  return map;
}

function unionDays(a: Map<string, OuraDoc>, b: Map<string, OuraDoc>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort();
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
