// Formatting helpers shared by the workspace, governance and fleet pages (dates, relative times, labels).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** "Oct 26, 2026". Date-only values ("2026-11-10") are calendar days: shown as is, in any timezone. */
export function fmtDate(iso: string | null | undefined): string {
  const t = parse(iso);
  if (t === null) return "–";
  return new Date(t).toLocaleDateString(undefined, DATE_ONLY.test(iso!) ? { dateStyle: "medium", timeZone: "UTC" } : { dateStyle: "medium" });
}

/** "Oct 26, 2026, 10:24". */
export function fmtDateTime(iso: string | null | undefined): string {
  const t = parse(iso);
  return t === null ? "–" : new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A duration as "5 min" / "3 h" / "12 d". */
export function fmtSpan(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return "<1 min";
  if (abs < HOUR) return `${Math.round(abs / MINUTE)} min`;
  if (abs < 2 * DAY) return `${Math.round(abs / HOUR)} h`;
  return `${Math.round(abs / DAY)} d`;
}

/** Relative to now in either direction: "in 3 d" / "5 h ago" / "now". */
export function fmtRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parse(iso);
  if (t === null) return "–";
  const ms = t - now;
  if (Math.abs(ms) < MINUTE) return "now";
  return ms > 0 ? `in ${fmtSpan(ms)}` : `${fmtSpan(ms)} ago`;
}

/** Whole days from now until ``iso`` (negative when past); null when there is no date. */
export function daysUntil(iso: string | null | undefined, now: number = Date.now()): number | null {
  const t = parse(iso);
  return t === null ? null : (t - now) / DAY;
}

/** "provision_failed" -> "Provision failed". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "–";
  const s = value.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Milliseconds as "820 ms" / "2.4 s". */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "–";
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

/** USD with cents below $100, whole dollars above (always list-price estimates in this app). */
export function fmtUsdExact(v: number | null | undefined): string {
  if (v == null) return "–";
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: v < 100 ? 2 : 0 });
}

/** Today as yyyy-mm-dd plus ``days`` (for <input type="date"> defaults and minimums). */
export function isoDay(days = 0, now: number = Date.now()): string {
  return new Date(now + days * DAY).toISOString().slice(0, 10);
}

/** Pretty JSON for before/after payloads; strings stay as is. */
export function toJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A short display form for unknown field values (lists joined, objects as compact JSON). */
export function shortValue(value: unknown, max = 160): string {
  if (value === null || value === undefined || value === "") return "–";
  let s: string;
  if (Array.isArray(value)) s = value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
