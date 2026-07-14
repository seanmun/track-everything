import { and, asc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { events, type Event } from "../db/schema.js";
import { nowIso, toZonedIso, todayKey } from "../util/time.js";

const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_REMIND_MIN = 60;

export interface CreatedEvent {
  event: Event;
  conflicts: Event[];
}

interface EventInput {
  messageId: number | null;
  title: string;
  startTime: string; // ISO
  endTime?: string | null;
  location?: string | null;
  notes?: string | null;
  allDay?: boolean;
  remindMinutesBefore?: number | null;
}

/** Create an event, returning it plus any existing events it overlaps. */
export function createEvent(input: EventInput): CreatedEvent {
  const startMs = Date.parse(input.startTime);
  const remindMin = input.remindMinutesBefore ?? DEFAULT_REMIND_MIN;
  const remindAt =
    input.allDay || !Number.isFinite(startMs) || remindMin <= 0
      ? null
      : toZonedIso(startMs - remindMin * 60_000);

  const res = db
    .insert(events)
    .values({
      messageId: input.messageId,
      title: input.title,
      startTime: input.startTime,
      endTime: input.endTime ?? null,
      allDay: input.allDay ?? false,
      location: input.location ?? null,
      notes: input.notes ?? null,
      remindAt,
      reminded: false,
      createdAt: nowIso(),
    })
    .run();

  const id = Number(res.lastInsertRowid);
  const event = db.select().from(events).where(eq(events.id, id)).get()!;
  return { event, conflicts: findConflicts(event) };
}

/** Events overlapping the given one (excluding itself). Missing end = 60 min. */
export function findConflicts(target: Event): Event[] {
  if (target.allDay) return conflictsForAllDay(target);
  const [aStart, aEnd] = span(target);

  // Only compare against a nearby window for efficiency.
  const dayBefore = toZonedIso(aStart - 86_400_000);
  const dayAfter = toZonedIso(aEnd + 86_400_000);
  const candidates = db
    .select()
    .from(events)
    .where(and(gte(events.startTime, dayBefore), lte(events.startTime, dayAfter)))
    .all();

  return candidates.filter((c) => {
    if (c.id === target.id || c.allDay) return false;
    const [bStart, bEnd] = span(c);
    return aStart < bEnd && aEnd > bStart;
  });
}

function conflictsForAllDay(target: Event): Event[] {
  const day = target.startTime.slice(0, 10);
  return db
    .select()
    .from(events)
    .all()
    .filter((c) => c.id !== target.id && c.startTime.slice(0, 10) === day);
}

/** Upcoming events from now forward. */
export function upcomingEvents(limit = 20): Event[] {
  return db
    .select()
    .from(events)
    .where(gte(events.startTime, nowIso()))
    .orderBy(asc(events.startTime))
    .limit(limit)
    .all();
}

/** Events scheduled for today (local). */
export function todaysEvents(): Event[] {
  const key = todayKey();
  return db
    .select()
    .from(events)
    .orderBy(asc(events.startTime))
    .all()
    .filter((e) => e.startTime.slice(0, 10) === key);
}

/** Events whose reminder is due and not yet sent (and haven't started). */
export function dueReminders(): Event[] {
  const now = nowIso();
  return db
    .select()
    .from(events)
    .where(and(eq(events.reminded, false), isNotNull(events.remindAt), lte(events.remindAt, now)))
    .all()
    .filter((e) => e.startTime >= now);
}

/** Reminders that were missed (start already passed) — mark done, don't send. */
export function staleReminders(): Event[] {
  const now = nowIso();
  return db
    .select()
    .from(events)
    .where(and(eq(events.reminded, false), isNotNull(events.remindAt)))
    .all()
    .filter((e) => e.startTime < now);
}

export function markReminded(id: number): void {
  db.update(events).set({ reminded: true }).where(eq(events.id, id)).run();
}

/** One-line human label for an event. */
export function formatEvent(e: Event): string {
  const when = e.allDay
    ? `${e.startTime.slice(0, 10)} (all day)`
    : `${e.startTime.slice(0, 10)} ${e.startTime.slice(11, 16)}`;
  const loc = e.location ? ` @ ${e.location}` : "";
  return `${when} — ${e.title}${loc}`;
}

function span(e: Event): [number, number] {
  const start = Date.parse(e.startTime);
  const end = e.endTime ? Date.parse(e.endTime) : start + DEFAULT_DURATION_MS;
  return [start, Number.isFinite(end) ? end : start + DEFAULT_DURATION_MS];
}
