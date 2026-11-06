import { describe, expect, it } from "vitest";
import { parseSkillMd, parseYaml, splitTools, validateFrontmatter } from "./skillmd";

const fm = (yaml: string, body = "# Steps\n1. Do it.") => `---\n${yaml}\n---\n\n${body}\n`;

describe("SKILL.md frontmatter", () => {
  it("parses the spec fields, nested metadata and space-delimited allowed-tools", () => {
    const r = parseSkillMd(fm(`name: cohort-builder
description: Builds patient cohorts from the clinical lakehouse. Use when someone asks for a cohort.
license: Apache-2.0
allowed-tools: Read Bash(git status:*) Bash(databricks:*)
metadata:
  author: care-ops
  version: "1.0"`));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.frontmatter).toMatchObject({ name: "cohort-builder", license: "Apache-2.0", metadata: { author: "care-ops", version: "1.0" } });
    expect(r.tools).toEqual(["Read", "Bash(git status:*)", "Bash(databricks:*)"]);
    expect(r.body).toBe("# Steps\n1. Do it.\n");
  });

  it("reads folded and literal block scalars, quoted strings, flow lists and comments", () => {
    const { data, errors } = parseYaml(`# a comment
name: 'pdf-tools'
description: >
  Extract text and tables
  from PDFs.

  Use for forms.
compatibility: |
  Python 3.11+
  network access
tags: [pdf, "forms, docs"]
license: MIT # inline comment`);
    expect(errors).toEqual([]);
    expect(data.name).toBe("pdf-tools");
    expect(data.description).toBe("Extract text and tables from PDFs.\nUse for forms.");
    expect(data.compatibility).toBe("Python 3.11+\nnetwork access");
    expect(data.tags).toEqual(["pdf", "forms, docs"]);
    expect(data.license).toBe("MIT");
  });

  it("enforces the name rules", () => {
    const err = (name: string) => validateFrontmatter({ name, description: "Does a thing well; use it whenever a thing must be done well." }).errors.map((e) => e.message);
    expect(err("good-name-2")).toEqual([]);
    expect(err("Bad_Name")).toEqual(["name may only contain lowercase letters, digits and hyphens"]);
    expect(err("-leading")).toEqual(["name must not start or end with a hyphen"]);
    expect(err("double--dash")).toEqual(["name must not contain consecutive hyphens"]);
    expect(err("a".repeat(65))).toEqual(["name is 65 characters; the maximum is 64"]);
    expect(validateFrontmatter({ description: "x".repeat(50) }).errors[0]).toEqual({ field: "name", message: "name is required" });
  });

  it("enforces description, compatibility and metadata limits", () => {
    const base = { name: "ok" };
    expect(validateFrontmatter({ ...base }).errors.map((e) => e.field)).toEqual(["description"]);
    expect(validateFrontmatter({ ...base, description: "d".repeat(1025) }).errors[0].message).toBe("description is 1025 characters; the maximum is 1024");
    expect(validateFrontmatter({ ...base, description: "d".repeat(1024) }).errors).toEqual([]);
    expect(validateFrontmatter({ ...base, description: "d".repeat(60), compatibility: "c".repeat(501) }).errors[0].field).toBe("compatibility");
    expect(validateFrontmatter({ ...base, description: "d".repeat(60), metadata: ["a"] }).errors[0].message).toBe("metadata must be a key: value map");
  });

  it("warns (not fails) on unknown keys, list or comma tools, short descriptions and an empty body", () => {
    const r = parseSkillMd(`---\nname: tiny\ndescription: Short.\nallowed-tools:\n  - Read\n  - Write\nversion: 2\n---\n`);
    expect(r.valid).toBe(true);
    expect(r.tools).toEqual(["Read", "Write"]);
    expect(r.warnings.map((w) => w.field).sort()).toEqual(["allowed-tools", "body", "description", "version"]);
    expect(splitTools("Read, Grep")).toEqual(["Read", "Grep"]);
  });

  it("rejects a file without frontmatter or with unparseable lines", () => {
    expect(parseSkillMd("# just markdown").errors[0].message).toMatch(/must start with YAML frontmatter/);
    const bad = parseSkillMd(fm("name: x\nthis is not yaml\ndescription: Something long enough to be a description."));
    expect(bad.valid).toBe(false);
    expect(bad.errors[0].message).toMatch(/Line 3: expected "key: value"/);
    expect(parseSkillMd("﻿---\r\nname: crlf-ok\r\ndescription: Works with Windows line endings and a BOM.\r\n---\r\nBody\r\n").valid).toBe(true);
  });
});
