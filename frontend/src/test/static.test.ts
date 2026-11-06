// Source-level guards over everything in src/.
//
// Effects must have block bodies. An expression-bodied arrow returns its value to React as the cleanup; for a
// call that returns a Promise (Chrome's element.scrollIntoView() does) React later calls the Promise as a
// function and the whole app blanks.
import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const SELF = "./static.test.ts";
const EXPRESSION_EFFECT = /\buse(?:Layout|Insertion)?Effect\(\s*(?:async\s*)?\(\s*\)\s*=>(?!\s*\{)/g;

function offenders(pattern: RegExp): string[] {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return Object.entries(SOURCES)
    .filter(([file]) => !file.endsWith(SELF.slice(1)))
    .flatMap(([file, text]) =>
      [...text.matchAll(global)].map((m) => {
        const line = text.slice(0, m.index).split("\n").length;
        return `${file}:${line}: ${text.split("\n")[line - 1].trim()}`;
      }),
    );
}

const matches = (source: string) => new RegExp(EXPRESSION_EFFECT.source).test(source);

describe("static source rules", () => {
  it("scans the app sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(10);
  });

  it("the effect rule catches expression bodies and allows block bodies", () => {
    expect(matches("useEffect(() => el.scrollIntoView(), [x]);")).toBe(true);
    expect(matches("useLayoutEffect(() => setOpen(false), []);")).toBe(true);
    expect(matches("useEffect(async () => load(), []);")).toBe(true);
    expect(matches("useEffect(\n  () =>\n    refresh(),\n  [],\n);")).toBe(true);
    expect(matches("useEffect(() => {")).toBe(false);
    expect(matches("useEffect(() =>\n  {")).toBe(false);
  });

  it("has no expression-bodied useEffect / useLayoutEffect anywhere in src", () => {
    expect(offenders(EXPRESSION_EFFECT)).toEqual([]);
  });

  it("ships no TODO / FIXME markers", () => {
    expect(offenders(/\b(TODO|FIXME|XXX)\b/)).toEqual([]);
  });
});
