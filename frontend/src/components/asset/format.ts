// Formatting + validation helpers for the discovery and entity views (complements lib/assets fmt*).
import { fmtUsd } from "../../lib/assets";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

/** Split "a@x.com, b@y.com; c@z.com" into trimmed, non-empty parts. */
export function splitList(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtDay(day: string): string {
  const d = new Date(day.length <= 10 ? `${day}T00:00:00Z` : day);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** Money with enough precision for unit economics ($0.0042 / 1k stays visible). */
export function fmtUsdUnit(v: number | null | undefined): string {
  if (v == null) return "–";
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return fmtUsd(v);
}

/** $ per 1k requests from a cost and a request count. */
export function per1k(cost: number | null | undefined, requests: number | null | undefined): number | null {
  if (cost == null || !requests) return null;
  return (cost / requests) * 1000;
}

/** Whole days since ``iso`` (0 on the same day). */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** YYYY-MM-DD for a date ``days`` from today (local calendar). */
export function isoDateFromToday(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** "YYYY-MM-DD" → the end of that day in the user's time zone, as ISO-8601 UTC (an effective date shown on that day). */
export function endOfLocalDayIso(date: string): string | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).toISOString();
}

export function shortHash(hash: string | null | undefined, n = 10): string {
  return hash ? hash.slice(0, n) : "–";
}

/** Values that count as "not set" for a description field. */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Next semver for a change: major when breaking, else minor. Non-semver versions get ".1" appended. */
export function suggestVersion(current: string | null | undefined, breaking: boolean): string {
  const raw = (current ?? "").trim().replace(/^v/i, "");
  const m = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return raw ? `${raw}.1` : breaking ? "2.0.0" : "1.1.0";
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return breaking ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
}
