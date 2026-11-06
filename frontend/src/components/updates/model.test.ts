import { describe, expect, it } from "vitest";
import type { CandidateStatus } from "../../lib/types";
import { candidate, overview } from "./fixtures.test-utils";
import {
  acceptBody, acceptProblem, acknowledgeBody, actionsFor, bannerCounts, bannerSignature, bannerText, bannerVisible, dayStartIso, defaultDelayDate,
  delayBody, delayProblem, groupCandidates, groupOf, localDay, readSettings, rejectBody, splitCode, watchKpis,
} from "./model";

describe("platform updates · grouping", () => {
  it("buckets every status into Ready / Needs attention / Testing & detected / Delayed / History", () => {
    const expected: Record<CandidateStatus, string> = {
      passed: "ready", failed: "attention", apply_failed: "attention", detected: "inflight", testing: "inflight", accepted: "inflight",
      applying: "inflight", delayed: "delayed", applied: "history", rejected: "history",
    };
    for (const [status, group] of Object.entries(expected)) expect(groupOf(status as CandidateStatus)).toBe(group);
  });

  it("orders groups, puts breaking first among the ready ones and sorts delays by due date", () => {
    const a = candidate({ status: "passed", updated_at: "2026-10-26T12:00:00Z" });
    const b = candidate({ status: "passed", breaking: true, updated_at: "2026-10-20T12:00:00Z" });
    const d1 = candidate({ status: "delayed", delay_until: "2026-11-09T00:00:00Z" });
    const d2 = candidate({ status: "delayed", delay_until: "2026-11-02T00:00:00Z" });
    const f = candidate({ status: "apply_failed" });
    const h = candidate({ status: "rejected", decided_at: "2026-10-01T00:00:00Z" });
    const groups = groupCandidates([a, d1, h, b, f, d2]);
    expect(groups.map((g) => g.group.title)).toEqual(["Ready to review", "Needs attention", "Testing & detected", "Delayed", "History"]);
    expect(groups[0].items.map((c) => c.candidate_id)).toEqual([b.candidate_id, a.candidate_id]);
    expect(groups[1].items).toEqual([f]);
    expect(groups[2].items).toEqual([]);
    expect(groups[3].items.map((c) => c.candidate_id)).toEqual([d2.candidate_id, d1.candidate_id]);
    expect(groups[4].items).toEqual([h]);
  });
});

describe("platform updates · state-aware actions", () => {
  it("only a passed app release or capability can be accepted; advisories are acknowledged; moving or closed ones allow nothing", () => {
    expect(actionsFor({ kind: "app_release", status: "passed" })).toEqual(["accept", "delay", "reject", "check"]);
    expect(actionsFor({ kind: "capability", status: "failed" })).toEqual(["check", "delay", "reject"]);
    expect(actionsFor({ kind: "capability", status: "delayed" })).toEqual(["check", "delay", "reject"]);
    expect(actionsFor({ kind: "advisory", status: "passed" })).toEqual(["acknowledge", "delay", "check"]);
    for (const status of ["testing", "accepted", "applying", "applied", "rejected"] as CandidateStatus[]) {
      expect(actionsFor({ kind: "app_release", status })).toEqual([]);
      expect(actionsFor({ kind: "advisory", status })).toEqual([]);
    }
  });
});

describe("platform updates · decision payloads", () => {
  it("accepting a breaking change needs a note; a non-breaking accept sends no empty note", () => {
    expect(acceptProblem({ breaking: true }, "   ")).toMatch(/needs a note/);
    expect(() => acceptBody({ breaking: true }, "")).toThrow(/needs a note/);
    expect(acceptBody({ breaking: true }, "  Told the 3 subscribers on 26 Oct. ")).toEqual({ action: "accept", note: "Told the 3 subscribers on 26 Oct." });
    expect(acceptProblem({ breaking: false }, "")).toBeNull();
    expect(acceptBody({ breaking: false }, " ")).toEqual({ action: "accept" });
  });

  it("delay defaults to today + default_delay_days and sends the start of that local day", () => {
    const now = new Date(2026, 9, 26, 15, 30); // 26 Oct 2026, local afternoon
    expect(defaultDelayDate(7, now)).toBe("2026-11-02");
    expect(defaultDelayDate(0, now)).toBe("2026-10-27"); // never today
    expect(localDay(6, now)).toBe("2026-11-01");
    expect(delayBody("2026-11-02", "", now)).toEqual({ action: "delay", delay_until: new Date(2026, 10, 2).toISOString() });
    expect(delayBody("2026-11-02", " after the freeze ", now)).toEqual({ action: "delay", delay_until: dayStartIso("2026-11-02"), note: "after the freeze" });
    expect(delayProblem("2026-10-26", now)).toMatch(/after today/);
    expect(delayProblem("", now)).toMatch(/Pick a date/);
    expect(() => delayBody("2026-10-20", "", now)).toThrow();
  });

  it("reject needs a reason; acknowledge takes an optional note", () => {
    expect(() => rejectBody("  ")).toThrow(/reason/);
    expect(rejectBody(" Staying on 0.2 until the vendor fix. ")).toEqual({ action: "reject", note: "Staying on 0.2 until the vendor fix." });
    expect(acknowledgeBody("")).toEqual({ action: "acknowledge" });
    expect(acknowledgeBody("read")).toEqual({ action: "acknowledge", note: "read" });
  });
});

describe("platform updates · settings, KPIs, job notes", () => {
  it("fills server defaults and coerces JSON values", () => {
    expect(readSettings(undefined)).toEqual({ auto_upgrade: "non_breaking", relevance_threshold: 35, default_delay_days: 7, keep_failed_branch_hours: 72 });
    expect(readSettings({ auto_upgrade: "all", relevance_threshold: "50", default_delay_days: 14, keep_failed_branch_hours: null })).toEqual({
      auto_upgrade: "all", relevance_threshold: 50, default_delay_days: 14, keep_failed_branch_hours: 72,
    });
    expect(readSettings({ auto_upgrade: "sometimes" }).auto_upgrade).toBe("non_breaking");
  });

  it("counts applied candidates of the last 30 days only", () => {
    const now = new Date("2026-10-26T12:00:00Z").getTime();
    const rows = [
      candidate({ status: "applied", applied_at: "2026-10-20T00:00:00Z" }),
      candidate({ status: "applied", applied_at: "2026-08-01T00:00:00Z" }),
      candidate({ status: "passed" }),
    ];
    const k = watchKpis(overview({ counts: { passed: 1, testing: 2, delayed: 3, detected: 4, applied: 2 } }), rows, now);
    expect(k).toMatchObject({ ready: 2, attention: 1, testing: 2, delayed: 3, detected: 4, applied30d: 1, policy: "non_breaking" });
    expect(watchKpis(overview(), null).applied30d).toBeNull();
  });

  it("renders backtick command fragments of a not_configured note as code", () => {
    expect(splitCode("Run `python jobs/platform_updates.py --mode watch`")).toEqual([
      { text: "Run ", code: false },
      { text: "python jobs/platform_updates.py --mode watch", code: true },
    ]);
  });
});

describe("platform updates · admin banner wording", () => {
  it("states ready, breaking and failed counts, and keys dismissal on them", () => {
    const passed = [candidate({ breaking: true }), candidate()];
    const c = bannerCounts(overview({ ready: 2, attention: 1, counts: { passed: 2, failed: 1 } }), passed);
    expect(bannerText(c)).toBe("2 platform updates are ready for your decision (1 breaking) · 1 failed regression");
    expect(bannerSignature(c)).toBe("2|1|1");
    expect(bannerText({ ready: 1, attention: 0, failed: 0, applyFailed: 0, breaking: 0 })).toBe("1 platform update is ready for your decision");
    expect(bannerText({ ready: 0, attention: 1, failed: 1, applyFailed: 0, breaking: 0 })).toBe("1 platform update failed regression");
    expect(bannerText({ ready: 0, attention: 3, failed: 2, applyFailed: 1, breaking: 0 })).toBe("3 platform updates need attention (2 failed regression · 1 failed to apply)");
    expect(bannerVisible({ ready: 0, attention: 0, failed: 0, applyFailed: 0, breaking: 0 })).toBe(false);
    expect(bannerVisible(null)).toBe(false);
  });
});
