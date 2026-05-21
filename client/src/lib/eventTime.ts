import type { EventDetails } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function parseTime(value: string): { hours: number; minutes: number } | undefined {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return undefined;

  let hours = Number(match[1]);
  const minutes = Number(match[2] || "0");
  const period = match[3]?.toLowerCase();
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) return undefined;
  if (period === "pm" && hours < 12) hours += 12;
  if (period === "am" && hours === 12) hours = 0;
  return { hours, minutes };
}

export function parseEventStart(details: Pick<EventDetails, "date" | "time">): Date | undefined {
  const dateMatch = details.date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    const fallback = new Date(`${details.date} ${details.time}`.trim());
    return Number.isNaN(fallback.getTime()) ? undefined : fallback;
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]) - 1;
  const day = Number(dateMatch[3]);
  const parsedTime = parseTime(details.time) || { hours: 12, minutes: 0 };
  return new Date(year, month, day, parsedTime.hours, parsedTime.minutes);
}

function durationLabel(ms: number): string {
  const absolute = Math.max(0, ms);
  if (absolute < HOUR_MS) {
    const minutes = Math.max(1, Math.round(absolute / MINUTE_MS));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  if (absolute < DAY_MS) {
    const hours = Math.round(absolute / HOUR_MS);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  const days = Math.round(absolute / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function partyTimingLabel(details: Pick<EventDetails, "date" | "time">, now = new Date()): string {
  const start = parseEventStart(details);
  if (!start) return "Date TBA";

  const elapsed = now.getTime() - start.getTime();
  const today = startOfDay(now);
  const eventDay = startOfDay(start);
  const dayDiff = Math.round((today - eventDay) / DAY_MS);

  if (elapsed >= 0) {
    if (dayDiff === 0 || elapsed < 4 * HOUR_MS) return `Started ${durationLabel(elapsed)} ago`;
    if (dayDiff === 1) return "Happened yesterday";
    return `Happened ${dayDiff} days ago`;
  }

  const until = Math.abs(elapsed);
  if (eventDay === today) return `Starts in ${durationLabel(until)}`;
  if (eventDay - today === DAY_MS) return "Starts tomorrow";
  return `Starts in ${durationLabel(until)}`;
}
