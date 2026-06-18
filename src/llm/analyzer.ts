import { desc, asc } from "drizzle-orm";
import { MODELS, MAX_TOKENS } from "../config.js";
import { anthropic, textOf } from "./anthropic.js";
import { analyzerSystemPrompt } from "./prompts.js";
import { db } from "../db/client.js";
import { entries, biomarkers, type Entry, type Biomarker } from "../db/schema.js";

const ENTRY_CAP = 2000;

/**
 * Run the correlation analysis engine (§12). Pulls up to ENTRY_CAP most-recent
 * entries (older ones collapse into per-day summaries), plus all biomarkers,
 * serializes compactly by date, and asks Opus for a report.
 */
export async function runAnalysis(question?: string): Promise<string> {
  const allEntries = db.select().from(entries).orderBy(desc(entries.eventTime)).all();
  const allBiomarkers = db.select().from(biomarkers).orderBy(asc(biomarkers.drawnAt)).all();

  const serialized = serializeEntries(allEntries);
  const bio = serializeBiomarkers(allBiomarkers);

  const userContent = [
    question ? `USER QUESTION: ${question}\n` : "No specific question — run the standing facial-bloating investigation and surface the secondary findings.\n",
    "=== ENTRIES (most recent first; older days aggregated) ===",
    serialized,
    "",
    "=== BIOMARKERS (chronological) ===",
    bio || "(none)",
  ].join("\n");

  const res = await anthropic.messages.create({
    model: MODELS.analysis,
    max_tokens: MAX_TOKENS.analysis,
    temperature: 0.3,
    system: analyzerSystemPrompt(),
    messages: [{ role: "user", content: userContent }],
  });

  return textOf(res).trim();
}

function dayKey(eventTime: string): string {
  return eventTime.slice(0, 10);
}

/**
 * Serialize entries compactly. The most recent ENTRY_CAP entries are emitted
 * in full; anything beyond that is collapsed into a one-line per-day count by
 * category so long histories still fit the context window.
 */
function serializeEntries(all: Entry[]): string {
  const recent = all.slice(0, ENTRY_CAP);
  const older = all.slice(ENTRY_CAP);

  const lines: string[] = [];

  // Group recent entries by day for readability.
  const byDay = new Map<string, Entry[]>();
  for (const e of recent) {
    const k = dayKey(e.eventTime);
    const list = byDay.get(k) ?? [];
    list.push(e);
    byDay.set(k, list);
  }

  for (const [day, dayEntries] of byDay) {
    lines.push(`# ${day}`);
    for (const e of dayEntries) {
      const time = e.eventTime.slice(11, 16);
      const sub = e.subtype ? `/${e.subtype}` : "";
      lines.push(`  ${time} [${e.category}${sub}] ${e.summary} :: ${compactData(e.data)}`);
    }
  }

  if (older.length > 0) {
    lines.push("");
    lines.push(`# (older — ${older.length} entries aggregated by day/category)`);
    const agg = new Map<string, Map<string, number>>();
    for (const e of older) {
      const k = dayKey(e.eventTime);
      const cats = agg.get(k) ?? new Map<string, number>();
      cats.set(e.category, (cats.get(e.category) ?? 0) + 1);
      agg.set(k, cats);
    }
    for (const [day, cats] of agg) {
      const parts = [...cats.entries()].map(([c, n]) => `${c}:${n}`).join(" ");
      lines.push(`  ${day} ${parts}`);
    }
  }

  return lines.join("\n");
}

function serializeBiomarkers(all: Biomarker[]): string {
  return all
    .map((b) => {
      const range =
        b.refLow != null || b.refHigh != null ? ` [${b.refLow ?? "?"}-${b.refHigh ?? "?"}]` : "";
      const flag = b.flag ? ` (${b.flag})` : "";
      return `  ${b.drawnAt.slice(0, 10)} ${b.name} = ${b.value}${b.unit ?? ""}${range}${flag}`;
    })
    .join("\n");
}

function compactData(dataJson: string): string {
  try {
    const obj = JSON.parse(dataJson);
    return JSON.stringify(obj);
  } catch {
    return dataJson;
  }
}
