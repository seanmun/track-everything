import { config } from "../config.js";

/**
 * Return the current instant as an ISO 8601 string carrying the configured
 * timezone offset (America/New_York), e.g. 2026-06-14T21:30:00-04:00.
 */
export function nowIso(): string {
  return toZonedIso(new Date());
}

/**
 * Convert a Date (or ms epoch) into an ISO 8601 string with the configured
 * timezone's offset applied, rather than UTC "Z".
 */
export function toZonedIso(input: Date | number): string {
  const date = typeof input === "number" ? new Date(input) : input;
  return formatWithOffset(date, config.TZ);
}

/** YYYY-MM-DD for a given instant in the configured timezone. */
export function zonedDateKey(input: Date | number = new Date()): string {
  const date = typeof input === "number" ? new Date(input) : input;
  const parts = dateParts(date, config.TZ);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Today's date key (YYYY-MM-DD) in the configured timezone. */
export function todayKey(): string {
  return zonedDateKey(new Date());
}

/** N days ago as a date key (YYYY-MM-DD) in the configured timezone. */
export function daysAgoKey(days: number): string {
  return zonedDateKey(Date.now() - days * 86_400_000);
}

interface DateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function dateParts(date: Date, timeZone: string): DateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  // Intl can return "24" for midnight in some engines; normalize to "00".
  if (map.hour === "24") map.hour = "00";
  return {
    year: map.year ?? "0000",
    month: map.month ?? "01",
    day: map.day ?? "01",
    hour: map.hour ?? "00",
    minute: map.minute ?? "00",
    second: map.second ?? "00",
  };
}

/** Offset of a timezone at a given instant, formatted as ±HH:MM. */
function tzOffset(date: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const part = fmt.formatToParts(date).find((p) => p.type === "timeZoneName");
  const raw = part?.value ?? "GMT+00:00";
  // raw looks like "GMT-04:00"; strip the GMT prefix.
  const match = raw.match(/GMT([+-]\d{2}:\d{2})/);
  return match?.[1] ?? "+00:00";
}

function formatWithOffset(date: Date, timeZone: string): string {
  const p = dateParts(date, timeZone);
  const offset = tzOffset(date, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}
