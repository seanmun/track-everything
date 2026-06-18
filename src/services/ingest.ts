import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  messages,
  entries,
  biomarkers,
  type Message,
  type NewEntry,
} from "../db/schema.js";
import { nowIso } from "../util/time.js";
import type { FileKind } from "../util/files.js";
import { parseText, type ParsedEntry } from "../llm/parser.js";
import { analyzeImage, type VisionResult } from "../llm/vision.js";
import { extractBloodwork } from "../llm/bloodwork.js";

interface RawMessageInput {
  source: string;
  telegramMessageId?: number;
  rawText?: string | null;
  filePath?: string | null;
  fileKind?: FileKind | null;
  messageTime: string;
}

/** Persist the lossless raw message row. Always called BEFORE any LLM work. */
export function storeRawMessage(input: RawMessageInput): number {
  const res = db
    .insert(messages)
    .values({
      source: input.source,
      telegramMessageId: input.telegramMessageId ?? null,
      rawText: input.rawText ?? null,
      filePath: input.filePath ?? null,
      fileKind: input.fileKind ?? null,
      messageTime: input.messageTime,
      parseStatus: "pending",
      createdAt: nowIso(),
    })
    .run();
  return Number(res.lastInsertRowid);
}

function setMessageStatus(
  id: number,
  status: string,
  llmRaw?: string | null,
  error?: string | null,
): void {
  db.update(messages)
    .set({ parseStatus: status, llmRawResponse: llmRaw ?? null, parseError: error ?? null })
    .where(eq(messages.id, id))
    .run();
}

function insertParsedEntries(messageId: number, parsed: ParsedEntry[]): void {
  if (parsed.length === 0) return;
  const rows: NewEntry[] = parsed.map((e) => ({
    messageId,
    category: e.category,
    subtype: null,
    eventTime: e.event_time,
    summary: e.summary,
    data: JSON.stringify(e.data ?? {}),
    source: "manual",
    createdAt: nowIso(),
  }));
  db.insert(entries).values(rows).run();
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export async function ingestText(opts: {
  telegramMessageId: number;
  text: string;
  messageTimeIso: string;
}): Promise<string> {
  const messageId = storeRawMessage({
    source: "telegram_text",
    telegramMessageId: opts.telegramMessageId,
    rawText: opts.text,
    messageTime: opts.messageTimeIso,
  });

  if (!opts.text.trim()) {
    setMessageStatus(messageId, "empty");
    return "Empty message stored (nothing to parse).";
  }

  try {
    const { entries: parsed, raw } = await parseText(opts.text, opts.messageTimeIso);
    insertParsedEntries(messageId, parsed);
    setMessageStatus(messageId, parsed.length ? "ok" : "empty", raw);
    return formatParsedReply(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setMessageStatus(messageId, "failed", null, msg);
    return `Couldn't parse that, but your raw message is safely stored (id ${messageId}). You can /reprocess ${messageId} later.`;
  }
}

function formatParsedReply(parsed: ParsedEntry[]): string {
  if (parsed.length === 0) return "Stored — nothing structured to log.";
  const lines = parsed.map((e) => {
    const t = e.event_time.slice(11, 16);
    return `• [${e.category}] ${e.summary} (${t})`;
  });
  return `Logged ${parsed.length} ${parsed.length === 1 ? "entry" : "entries"}:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Photo (vision)
// ---------------------------------------------------------------------------

export async function ingestPhoto(opts: {
  telegramMessageId: number;
  filePath: string;
  caption?: string;
  messageTimeIso: string;
}): Promise<string> {
  const messageId = storeRawMessage({
    source: "telegram_photo",
    telegramMessageId: opts.telegramMessageId,
    rawText: opts.caption ?? null,
    filePath: opts.filePath,
    fileKind: "image",
    messageTime: opts.messageTimeIso,
  });

  const prior = getLastVisionScore(messageId);

  try {
    const { result, raw } = await analyzeImage(opts.filePath, opts.caption);
    db.insert(entries)
      .values({
        messageId,
        category: "appearance",
        subtype: "vision",
        eventTime: opts.messageTimeIso,
        summary: `Selfie: face bloat ${result.faceBloatingScore}/10, skin ${result.skinTone}`,
        data: JSON.stringify({ ...result, userCaption: opts.caption ?? null }),
        source: "vision",
        createdAt: nowIso(),
      })
      .run();
    setMessageStatus(messageId, "ok", raw);
    return formatVisionReply(result, prior);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setMessageStatus(messageId, "failed", null, msg);
    return `Photo saved safely (id ${messageId}) but vision analysis failed. /reprocess ${messageId} to retry.`;
  }
}

function getLastVisionScore(beforeMessageId: number): number | null {
  const row = db
    .select()
    .from(entries)
    .where(and(eq(entries.category, "appearance"), eq(entries.source, "vision")))
    .orderBy(desc(entries.createdAt))
    .limit(1)
    .get();
  if (!row) return null;
  try {
    const data = JSON.parse(row.data) as { faceBloatingScore?: number };
    return typeof data.faceBloatingScore === "number" ? data.faceBloatingScore : null;
  } catch {
    return null;
  }
}

function formatVisionReply(result: VisionResult, priorScore: number | null): string {
  const lines = [
    `Vision analysis:`,
    `• Facial bloating: ${result.faceBloatingScore}/10`,
    `• Under-eye puffiness: ${result.underEyePuffiness}/10`,
    `• Skin tone: ${result.skinTone}, redness ${result.redness}/10`,
    `• Jawline: ${result.jawlineDefinition}`,
    `• Confidence: ${result.confidence}`,
  ];
  if (result.blemishes.length) lines.push(`• Blemishes: ${result.blemishes.join(", ")}`);
  if (result.otherObservations.length)
    lines.push(`• Notes: ${result.otherObservations.join("; ")}`);
  if (priorScore != null) {
    lines.push(`\nFace bloat ${result.faceBloatingScore} vs ${priorScore} last photo.`);
  }
  lines.push(
    `\n(Reminder: a single photo's bloat score is swayed by lighting, angle, and time of day. It's only meaningful as a trend across consistent selfies.)`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Document (bloodwork or note)
// ---------------------------------------------------------------------------

export async function ingestDocument(opts: {
  telegramMessageId: number;
  filePath: string;
  fileKind: FileKind;
  fileName?: string;
  caption?: string;
  messageTimeIso: string;
}): Promise<string> {
  const messageId = storeRawMessage({
    source: "telegram_file",
    telegramMessageId: opts.telegramMessageId,
    rawText: opts.caption ?? null,
    filePath: opts.filePath,
    fileKind: opts.fileKind,
    messageTime: opts.messageTimeIso,
  });

  // Non-lab files: store + note entry referencing the file.
  if (opts.fileKind === "other") {
    db.insert(entries)
      .values({
        messageId,
        category: "note",
        subtype: "file",
        eventTime: opts.messageTimeIso,
        summary: `File stored: ${opts.fileName ?? opts.filePath}`,
        data: JSON.stringify({ text: opts.caption ?? "", filePath: opts.filePath, fileName: opts.fileName ?? null }),
        source: "manual",
        createdAt: nowIso(),
      })
      .run();
    setMessageStatus(messageId, "ok");
    return `File stored (id ${messageId}) and noted. Not a lab report, so nothing to extract.`;
  }

  try {
    return await extractAndStoreBloodwork(messageId, opts.filePath, opts.fileKind, opts.caption, opts.messageTimeIso);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setMessageStatus(messageId, "failed", null, msg);
    return `Document saved safely (id ${messageId}) but bloodwork extraction failed. /reprocess ${messageId} to retry.`;
  }
}

async function extractAndStoreBloodwork(
  messageId: number,
  filePath: string,
  fileKind: FileKind,
  caption: string | undefined,
  messageTimeIso: string,
): Promise<string> {
  const { result, raw } = await extractBloodwork(filePath, fileKind, caption);
  const drawnAt = result.drawnAt ?? messageTimeIso.slice(0, 10);

  let markerCount = 0;
  const flagged: string[] = [];

  for (const panel of result.panels) {
    const entryRes = db
      .insert(entries)
      .values({
        messageId,
        category: "biomarker",
        subtype: panel.name,
        eventTime: drawnAt,
        summary: `Bloodwork panel "${panel.name}" (${panel.markers.length} markers)`,
        data: JSON.stringify({ panel: panel.name, drawnAt, markers: panel.markers }),
        source: "bloodwork",
        createdAt: nowIso(),
      })
      .run();
    const entryId = Number(entryRes.lastInsertRowid);

    for (const m of panel.markers) {
      db.insert(biomarkers)
        .values({
          entryId,
          name: m.normalizedName || m.name,
          value: m.value,
          unit: m.unit,
          refLow: m.refLow,
          refHigh: m.refHigh,
          flag: m.flag,
          drawnAt,
        })
        .run();
      markerCount++;
      if (m.flag === "low" || m.flag === "high") {
        flagged.push(`${m.name} ${m.value}${m.unit ?? ""} (${m.flag})`);
      }
    }
  }

  setMessageStatus(messageId, "ok", raw);

  const lines = [
    `Extracted ${markerCount} markers across ${result.panels.length} panel(s), draw date ${drawnAt}.`,
  ];
  for (const panel of result.panels) {
    lines.push(`\n${panel.name}:`);
    for (const m of panel.markers) {
      const f = m.flag && m.flag !== "normal" ? ` ⚠️${m.flag}` : "";
      lines.push(`  • ${m.name}: ${m.value}${m.unit ?? ""}${f}`);
    }
  }
  if (flagged.length) lines.push(`\nOut of range: ${flagged.join("; ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reprocess & undo
// ---------------------------------------------------------------------------

/** Re-run the appropriate analyzer for one message, or all failed ones. */
export async function reprocess(messageId?: number): Promise<string> {
  const targets: Message[] = messageId
    ? db.select().from(messages).where(eq(messages.id, messageId)).all()
    : db.select().from(messages).where(eq(messages.parseStatus, "failed")).all();

  if (targets.length === 0) {
    return messageId ? `No message with id ${messageId}.` : "No failed messages to reprocess.";
  }

  let ok = 0;
  let failed = 0;
  for (const m of targets) {
    try {
      await reprocessOne(m);
      ok++;
    } catch {
      failed++;
    }
  }
  return `Reprocessed ${targets.length} message(s): ${ok} ok, ${failed} failed.`;
}

async function reprocessOne(m: Message): Promise<void> {
  // Clear previously derived rows for this message (raw is kept).
  deleteDerivedForMessages([m.id]);

  const msgTime = m.messageTime;
  if (m.source === "telegram_text" && m.rawText) {
    const { entries: parsed, raw } = await parseText(m.rawText, msgTime);
    insertParsedEntries(m.id, parsed);
    setMessageStatus(m.id, parsed.length ? "ok" : "empty", raw);
    return;
  }
  if (m.source === "telegram_photo" && m.filePath) {
    const { result, raw } = await analyzeImage(m.filePath, m.rawText ?? undefined);
    db.insert(entries)
      .values({
        messageId: m.id,
        category: "appearance",
        subtype: "vision",
        eventTime: msgTime,
        summary: `Selfie: face bloat ${result.faceBloatingScore}/10, skin ${result.skinTone}`,
        data: JSON.stringify({ ...result, userCaption: m.rawText ?? null }),
        source: "vision",
        createdAt: nowIso(),
      })
      .run();
    setMessageStatus(m.id, "ok", raw);
    return;
  }
  if (m.source === "telegram_file" && m.filePath) {
    if (m.fileKind === "pdf" || m.fileKind === "image") {
      await extractAndStoreBloodwork(m.id, m.filePath, m.fileKind, m.rawText ?? undefined, msgTime);
    } else {
      setMessageStatus(m.id, "ok");
    }
    return;
  }
  throw new Error(`Cannot reprocess message ${m.id} (source ${m.source}).`);
}

/** Delete entries (and their biomarkers) from the most recent message. */
export function undoLast(): string {
  const lastWithEntries = db
    .select({ messageId: entries.messageId })
    .from(entries)
    .where(isNotNull(entries.messageId))
    .orderBy(desc(entries.id))
    .limit(1)
    .get();

  if (!lastWithEntries?.messageId) return "Nothing to undo.";
  const removed = deleteDerivedForMessages([lastWithEntries.messageId]);
  return `Removed ${removed} derived entr${removed === 1 ? "y" : "ies"} from message ${lastWithEntries.messageId}. Raw message kept.`;
}

function deleteDerivedForMessages(messageIds: number[]): number {
  if (messageIds.length === 0) return 0;
  const entryRows = db
    .select({ id: entries.id })
    .from(entries)
    .where(inArray(entries.messageId, messageIds))
    .all();
  const entryIds = entryRows.map((r) => r.id);
  if (entryIds.length > 0) {
    db.delete(biomarkers).where(inArray(biomarkers.entryId, entryIds)).run();
    db.delete(entries).where(inArray(entries.id, entryIds)).run();
  }
  return entryIds.length;
}
