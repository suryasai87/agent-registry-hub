// SKILL.md frontmatter parsing and validation against the Agent Skills specification (agentskills.io):
//   name           required · 1-64 chars · lowercase letters, digits, hyphens · no leading/trailing/consecutive "-"
//   description    required · non-empty · at most 1024 chars · says what the skill does and when to use it
//   license        optional · a license name or a bundled license file
//   compatibility  optional · at most 500 chars
//   metadata       optional · string → string map
//   allowed-tools  optional (experimental) · space-delimited list of pre-approved tools
// The YAML subset covers what SKILL.md files use: scalars (plain / quoted), block scalars (| and >), "- item"
// lists, [a, b] flow lists, and one level of nested maps.

export type YamlValue = string | string[] | Record<string, string>;

export interface Issue {
  field: string;
  message: string;
}

export interface ParsedSkill {
  frontmatter: Record<string, YamlValue> | null;
  body: string;
  errors: Issue[];
  warnings: Issue[];
  /** allowed-tools as a list. */
  tools: string[];
  valid: boolean;
}

export const SPEC_KEYS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"] as const;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;
export const BODY_LINES_RECOMMENDED = 500;

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/;

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\/bfnrt])/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" })[c as "n"] ?? c);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Strip a trailing " # comment" from a plain (unquoted) scalar. */
function stripComment(v: string): string {
  if (v.startsWith('"') || v.startsWith("'")) return v;
  const i = v.search(/\s#/);
  return (i >= 0 ? v.slice(0, i) : v).trim();
}

function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => unquote(s)).filter((s) => s !== "");
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Split SKILL.md into its frontmatter text and body. */
export function splitFrontmatter(md: string): { yaml: string; body: string } | null {
  const text = md.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n([\s\S]*))?$/.exec(text);
  if (!m) return null;
  return { yaml: m[1], body: (m[2] ?? "").replace(/^\n+/, "") };
}

export function parseYaml(yaml: string): { data: Record<string, YamlValue>; errors: Issue[]; warnings: Issue[] } {
  const lines = yaml.split("\n");
  const data: Record<string, YamlValue> = {};
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    if (indentOf(raw) > 0) {
      errors.push({ field: "frontmatter", message: `Line ${i + 2}: unexpected indentation` });
      i++;
      continue;
    }
    const m = KEY_LINE.exec(raw.trimEnd());
    if (!m) {
      errors.push({ field: "frontmatter", message: `Line ${i + 2}: expected "key: value", got “${raw.trim().slice(0, 40)}”` });
      i++;
      continue;
    }
    const key = m[1];
    const rest = (m[2] ?? "").trim();
    if (key in data) warnings.push({ field: key, message: `“${key}” appears more than once; the last value wins` });
    i++;
    // Indented continuation lines belong to this key.
    const block: string[] = [];
    while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > 0)) {
      block.push(lines[i]);
      i++;
    }
    while (block.length && block[block.length - 1].trim() === "") block.pop();

    const blockScalar = /^([|>])([+-]?)\s*(#.*)?$/.exec(rest);
    if (blockScalar) {
      const literal = blockScalar[1] === "|";
      const chomp = blockScalar[2];
      const nonEmpty = block.filter((l) => l.trim());
      const pad = nonEmpty.length ? Math.min(...nonEmpty.map(indentOf)) : 0;
      const body = block.map((l) => l.slice(Math.min(pad, indentOf(l))));
      let text: string;
      if (literal) text = body.join("\n");
      else {
        text = "";
        for (const l of body) {
          if (l.trim() === "") text += "\n";
          else text += (text && !text.endsWith("\n") ? " " : "") + l.trim();
        }
      }
      data[key] = chomp === "+" ? `${text}\n` : text.replace(/\s+$/, chomp === "-" ? "" : "");
      continue;
    }
    if (rest === "" || rest.startsWith("#")) {
      const items = block.filter((l) => l.trim() && !l.trim().startsWith("#"));
      if (items.length === 0) data[key] = "";
      else if (items.every((l) => /^-(\s|$)/.test(l.trim()))) data[key] = items.map((l) => unquote(stripComment(l.trim().slice(1).trim())));
      else if (items.every((l) => KEY_LINE.test(l.trim()))) {
        const map: Record<string, string> = {};
        for (const l of items) {
          const km = KEY_LINE.exec(l.trim())!;
          map[km[1]] = unquote(stripComment(km[2] ?? ""));
        }
        data[key] = map;
      } else {
        data[key] = items.map((l) => l.trim()).join(" ");
        warnings.push({ field: key, message: `“${key}” mixes list items and text; read as plain text` });
      }
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = splitFlow(rest.slice(1, -1));
      continue;
    }
    if (rest.startsWith("{") && rest.endsWith("}")) {
      const map: Record<string, string> = {};
      for (const part of splitFlow(rest.slice(1, -1))) {
        const j = part.indexOf(":");
        if (j > 0) map[part.slice(0, j).trim()] = unquote(part.slice(j + 1));
      }
      data[key] = map;
      continue;
    }
    // Plain or quoted scalar, possibly folded over indented continuation lines.
    const first = stripComment(rest);
    const cont = block.filter((l) => l.trim()).map((l) => l.trim());
    data[key] = unquote([first, ...cont].join(" "));
  }
  return { data, errors, warnings };
}

/** allowed-tools tokens: space-delimited, keeping "Bash(git status:*)" together. */
export function splitTools(value: YamlValue | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((t) => t.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (/\s/.test(ch) || ch === ",")) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function validateFrontmatter(fm: Record<string, YamlValue>, body = ""): { errors: Issue[]; warnings: Issue[]; tools: string[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const name = fm.name;
  if (name === undefined || name === "") errors.push({ field: "name", message: "name is required" });
  else if (typeof name !== "string") errors.push({ field: "name", message: "name must be a single string" });
  else {
    if (name.length > NAME_MAX) errors.push({ field: "name", message: `name is ${name.length} characters; the maximum is ${NAME_MAX}` });
    if (!/^[a-z0-9-]+$/.test(name)) errors.push({ field: "name", message: "name may only contain lowercase letters, digits and hyphens" });
    else if (name.startsWith("-") || name.endsWith("-")) errors.push({ field: "name", message: "name must not start or end with a hyphen" });
    else if (name.includes("--")) errors.push({ field: "name", message: "name must not contain consecutive hyphens" });
  }

  const description = fm.description;
  if (description === undefined || (typeof description === "string" && description.trim() === "")) errors.push({ field: "description", message: "description is required and must not be empty" });
  else if (typeof description !== "string") errors.push({ field: "description", message: "description must be text" });
  else {
    if (description.length > DESCRIPTION_MAX) errors.push({ field: "description", message: `description is ${description.length} characters; the maximum is ${DESCRIPTION_MAX}` });
    if (description.trim().length < 40) warnings.push({ field: "description", message: "Say what the skill does and when to use it; agents pick skills from this text" });
  }

  if (fm.license !== undefined && typeof fm.license !== "string") errors.push({ field: "license", message: "license must be a string" });
  if (fm.compatibility !== undefined) {
    if (typeof fm.compatibility !== "string") errors.push({ field: "compatibility", message: "compatibility must be a string" });
    else if (fm.compatibility.length > COMPATIBILITY_MAX) errors.push({ field: "compatibility", message: `compatibility is ${fm.compatibility.length} characters; the maximum is ${COMPATIBILITY_MAX}` });
  }
  if (fm.metadata !== undefined && (typeof fm.metadata !== "object" || Array.isArray(fm.metadata))) errors.push({ field: "metadata", message: "metadata must be a key: value map" });

  const rawTools = fm["allowed-tools"];
  const tools = splitTools(rawTools);
  if (Array.isArray(rawTools)) warnings.push({ field: "allowed-tools", message: "The spec uses a space-delimited string (e.g. “Read Bash(git:*)”); a list is accepted" });
  else if (typeof rawTools === "string" && /,/.test(rawTools.replace(/\([^)]*\)/g, ""))) warnings.push({ field: "allowed-tools", message: "allowed-tools is space-delimited in the spec; commas were treated as separators" });
  else if (rawTools !== undefined && typeof rawTools !== "string") errors.push({ field: "allowed-tools", message: "allowed-tools must be a space-delimited string" });

  for (const key of Object.keys(fm)) {
    if (!(SPEC_KEYS as readonly string[]).includes(key)) warnings.push({ field: key, message: `“${key}” isn't an Agent Skills field; move it under metadata` });
  }

  const lines = body.trim() ? body.trim().split("\n").length : 0;
  if (lines === 0) warnings.push({ field: "body", message: "There are no instructions after the frontmatter" });
  else if (lines > BODY_LINES_RECOMMENDED) warnings.push({ field: "body", message: `The body is ${lines} lines; keep SKILL.md under ${BODY_LINES_RECOMMENDED} and move detail into referenced files` });

  return { errors, warnings, tools };
}

export function parseSkillMd(md: string): ParsedSkill {
  const split = splitFrontmatter(md);
  if (!split) {
    return {
      frontmatter: null, body: md, tools: [], valid: false, warnings: [],
      errors: [{ field: "frontmatter", message: "SKILL.md must start with YAML frontmatter between two “---” lines" }],
    };
  }
  const yaml = parseYaml(split.yaml);
  const v = validateFrontmatter(yaml.data, split.body);
  const errors = [...yaml.errors, ...v.errors];
  return { frontmatter: yaml.data, body: split.body, errors, warnings: [...yaml.warnings, ...v.warnings], tools: v.tools, valid: errors.length === 0 };
}
