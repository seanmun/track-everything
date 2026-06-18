import { and, desc, eq, like, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { messages, entries, biomarkers, type Entry } from "../db/schema.js";
import { todayKey, daysAgoKey } from "../util/time.js";

// ---------------------------------------------------------------------------
// /today
// ---------------------------------------------------------------------------

export function todayReport(): string {
  const day = todayKey();
  const rows = db
    .select()
    .from(entries)
    .where(like(entries.eventTime, `${day}%`))
    .orderBy(entries.eventTime)
    .all();

  if (rows.length === 0) return `No entries for ${day} yet.`;
  return `Today (${day}):\n${groupByCategory(rows)}`;
}

// ---------------------------------------------------------------------------
// /recent [n]
// ---------------------------------------------------------------------------

export function recentReport(n = 10): string {
  const rows = db.select().from(entries).orderBy(desc(entries.eventTime)).limit(n).all();
  if (rows.length === 0) return "No entries yet.";
  const lines = rows.map((e) => {
    const sub = e.subtype ? `/${e.subtype}` : "";
    return `• ${e.eventTime.slice(0, 16).replace("T", " ")} [${e.category}${sub}] ${e.summary}`;
  });
  return `Last ${rows.length} entries:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// /stats
// ---------------------------------------------------------------------------

export function statsReport(): string {
  const counts = db
    .select({ category: entries.category, n: sql<number>`count(*)` })
    .from(entries)
    .groupBy(entries.category)
    .all();

  const range = db
    .select({
      min: sql<string | null>`min(${entries.eventTime})`,
      max: sql<string | null>`max(${entries.eventTime})`,
    })
    .from(entries)
    .get();

  const lines: string[] = ["Stats:"];

  if (range?.min && range?.max) {
    lines.push(`Date range: ${range.min.slice(0, 10)} → ${range.max.slice(0, 10)}`);
  }

  lines.push("");
  lines.push("Counts by category:");
  for (const c of counts.sort((a, b) => b.n - a.n)) {
    lines.push(`  ${c.category}: ${c.n}`);
  }

  // Last weight
  const lastWeight = latestEntry("weight");
  if (lastWeight) {
    const d = parseData<{ value?: number; unit?: string }>(lastWeight);
    lines.push("");
    lines.push(`Last weight: ${d.value ?? "?"} ${d.unit ?? ""} (${lastWeight.eventTime.slice(0, 10)})`);
  }

  // 7-day average Oura sleep
  const avgSleep = sevenDayAvgSleep();
  if (avgSleep != null) {
    lines.push(`7-day avg sleep (Oura): ${avgSleep}h`);
  }

  // Last readiness
  const lastReadiness = latestWearable("oura_readiness");
  if (lastReadiness) {
    const d = parseData<{ score?: number; temperatureDeviation?: number }>(lastReadiness);
    lines.push(`Last readiness: score ${d.score ?? "?"}, tempΔ ${d.temperatureDeviation ?? "?"}`);
  }

  // Recent biomarker flags
  const flags = db
    .select()
    .from(biomarkers)
    .where(sql`${biomarkers.flag} in ('low','high')`)
    .orderBy(desc(biomarkers.drawnAt))
    .limit(8)
    .all();
  if (flags.length) {
    lines.push("");
    lines.push("Recent out-of-range biomarkers:");
    for (const b of flags) {
      lines.push(`  ${b.name}: ${b.value}${b.unit ?? ""} (${b.flag}, ${b.drawnAt.slice(0, 10)})`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// /labs
// ---------------------------------------------------------------------------

export function labsReport(): string {
  const draws = db
    .select({ drawnAt: biomarkers.drawnAt })
    .from(biomarkers)
    .groupBy(biomarkers.drawnAt)
    .orderBy(desc(biomarkers.drawnAt))
    .all()
    .map((r) => r.drawnAt);

  if (draws.length === 0) return "No bloodwork on file yet. Upload a lab PDF or photo.";

  const latest = draws[0]!;
  const previous = draws[1];

  // Join markers to their panel (entries.subtype) for the latest draw.
  const rows = db
    .select({
      name: biomarkers.name,
      value: biomarkers.value,
      unit: biomarkers.unit,
      flag: biomarkers.flag,
      panel: entries.subtype,
    })
    .from(biomarkers)
    .leftJoin(entries, eq(biomarkers.entryId, entries.id))
    .where(eq(biomarkers.drawnAt, latest))
    .all();

  // Previous-draw values for trend arrows.
  const prevValues = new Map<string, number>();
  if (previous) {
    for (const b of db.select().from(biomarkers).where(eq(biomarkers.drawnAt, previous)).all()) {
      prevValues.set(b.name, b.value);
    }
  }

  const byPanel = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.panel ?? "Other";
    const list = byPanel.get(key) ?? [];
    list.push(r);
    byPanel.set(key, list);
  }

  const lines = [`Latest bloodwork (${latest}):`];
  for (const [panel, markers] of byPanel) {
    lines.push(`\n${panel}:`);
    for (const m of markers) {
      const flag = m.flag && m.flag !== "normal" ? ` ⚠️${m.flag}` : "";
      const prev = prevValues.get(m.name);
      const arrow = trendArrow(m.value, prev);
      lines.push(`  • ${m.name}: ${m.value}${m.unit ?? ""}${flag}${arrow}`);
    }
  }
  if (previous) lines.push(`\n(arrows vs previous draw ${previous})`);
  return lines.join("\n");
}

function trendArrow(value: number, prev: number | undefined): string {
  if (prev == null) return "";
  if (value > prev) return ` ↑ (was ${prev})`;
  if (value < prev) return ` ↓ (was ${prev})`;
  return ` → (unchanged)`;
}

// ---------------------------------------------------------------------------
// /export
// ---------------------------------------------------------------------------

export function exportJson(): string {
  const allMessages = db.select().from(messages).orderBy(messages.id).all();
  const allEntries = db.select().from(entries).orderBy(entries.id).all();
  const allBiomarkers = db.select().from(biomarkers).orderBy(biomarkers.id).all();
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      messages: allMessages,
      entries: allEntries.map((e) => ({ ...e, data: safeParse(e.data) })),
      biomarkers: allBiomarkers,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function groupByCategory(rows: Entry[]): string {
  const byCat = new Map<string, Entry[]>();
  for (const e of rows) {
    const list = byCat.get(e.category) ?? [];
    list.push(e);
    byCat.set(e.category, list);
  }
  const out: string[] = [];
  for (const [cat, list] of byCat) {
    out.push(`\n${cat}:`);
    for (const e of list) {
      out.push(`  • ${e.eventTime.slice(11, 16)} ${e.summary}`);
    }
  }
  return out.join("\n");
}

function latestEntry(category: string): Entry | undefined {
  return db
    .select()
    .from(entries)
    .where(eq(entries.category, category))
    .orderBy(desc(entries.eventTime))
    .limit(1)
    .get();
}

function latestWearable(subtype: string): Entry | undefined {
  return db
    .select()
    .from(entries)
    .where(and(eq(entries.category, "wearable"), eq(entries.subtype, subtype)))
    .orderBy(desc(entries.eventTime))
    .limit(1)
    .get();
}

function sevenDayAvgSleep(): number | null {
  const since = daysAgoKey(7);
  const rows = db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.category, "wearable"),
        eq(entries.subtype, "oura_sleep"),
        sql`${entries.eventTime} >= ${since}`,
      ),
    )
    .all();
  const hours = rows
    .map((r) => parseData<{ totalSleepHours?: number | null }>(r).totalSleepHours)
    .filter((h): h is number => typeof h === "number");
  if (hours.length === 0) return null;
  const avg = hours.reduce((a, b) => a + b, 0) / hours.length;
  return Math.round(avg * 100) / 100;
}

function parseData<T>(entry: Entry): T {
  return safeParse(entry.data) as T;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
