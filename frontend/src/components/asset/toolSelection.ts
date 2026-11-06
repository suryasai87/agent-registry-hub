// MCP tool selection rules, mirrored from app/registry/tool_selection.py so the editor previews every keystroke
// locally; the server re-validates and computes the impact on "Preview impact". Selectors are exact tool names or a
// prefix ending in *, at most 1,024 of at most 256 characters, no ! exclusions. An EMPTY selection exposes every tool.
import type { SelectionTool } from "../../lib/types";

export const MAX_SELECTORS = 1024;
export const MAX_SELECTOR_LEN = 256;

export interface SelectorCheck {
  selectors: string[];
  errors: string[];
  warnings: string[];
}

export function parseSelectors(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

export function validateSelectors(input: string[], limits = { max_selectors: MAX_SELECTORS, max_length: MAX_SELECTOR_LEN }): SelectorCheck {
  const selectors: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const raw of input) {
    const s = raw.trim();
    if (!s) continue;
    if (selectors.includes(s)) {
      warnings.push(`“${s}” is listed twice`);
      continue;
    }
    if (s.startsWith("!")) errors.push(`“${s}”: exclusions (!) are not supported. List the tools to include instead`);
    else if (s === "*") errors.push("“*”: leave the selection empty to expose every tool");
    else if (s.slice(0, -1).includes("*")) errors.push(`“${s}”: use an exact tool name or a prefix that ends with a single *`);
    else if (s.length > limits.max_length) errors.push(`“${s.slice(0, 40)}…”: a selector can have at most ${limits.max_length} characters`);
    else if (/[\s\u0000-\u001f]/.test(s)) errors.push(`“${s}”: tool names can't contain spaces or control characters`);
    selectors.push(s);
  }
  if (selectors.length > limits.max_selectors) errors.push(`At most ${limits.max_selectors.toLocaleString("en-US")} selectors are allowed (${selectors.length.toLocaleString("en-US")} given)`);
  return { selectors, errors, warnings };
}

export function selects(name: string, selectors: string[]): boolean {
  if (!selectors.length) return true;
  return selectors.some((s) => (s.endsWith("*") ? name.startsWith(s.slice(0, -1)) : name === s));
}

export interface SelectionDiff {
  rows: (SelectionTool & { exposed_after: boolean })[];
  removed: string[];
  added: string[];
  unmatched: string[];
  breaking: boolean;
  changed: boolean;
  narrowsAll: boolean;
}

export function diffSelection(tools: SelectionTool[], current: string[], next: string[]): SelectionDiff {
  const rows = tools.map((t) => ({ ...t, exposed_now: selects(t.name, current), exposed_after: selects(t.name, next) }));
  const removed = rows.filter((r) => r.exposed_now && !r.exposed_after).map((r) => r.name);
  const added = rows.filter((r) => !r.exposed_now && r.exposed_after).map((r) => r.name);
  const unmatched = next.filter((s) => !tools.some((t) => selects(t.name, [s])));
  const narrowsAll = current.length === 0 && next.length > 0;
  const same = [...current].sort().join("\n") === [...next].sort().join("\n");
  return { rows, removed, added, unmatched, breaking: removed.length > 0 || narrowsAll, changed: !same, narrowsAll };
}
