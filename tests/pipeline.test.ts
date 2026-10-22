import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OrgProfileSchema } from "../src/profile.js";
import { evaluateAll, ingestEmail, recordDecision } from "../src/pipeline.js";
import { parseFundingForward } from "../src/parser.js";
import { Store } from "../src/store.js";
import type { RawEmail } from "../src/types.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const now = new Date("2026-10-20T12:00:00Z");
const email1: RawEmail = { id: "m1", subject: "Funding Forward: 10/19 - 10/23", received_at: "2026-10-19T12:00:00Z", body: fx("funding-forward-1.txt") };
const email2: RawEmail = { id: "m2", subject: "Funding Forward: 10/26 - 10/30", received_at: "2026-10-26T12:00:00Z", body: fx("funding-forward-2.txt") };
const profile = OrgProfileSchema.parse(JSON.parse(readFileSync(new URL("../examples/profile.json", import.meta.url), "utf8")));

describe("parser", () => {
  it("creates one candidate per block in the opportunities section only, with provenance", () => {
    const cs = parseFundingForward(email1);
    expect(cs).toHaveLength(5);
    expect(cs.every((c) => c.source_email_id === "m1" && c.source_block_text.length > 0)).toBe(true);
    const a = cs[0]!;
    expect(a.title).toBe("Example AI for Good Accelerator");
    expect(a.source_opportunity_url).toBe("https://example.org/ai-accelerator");
    expect(a.amount_max_usd).toBe(250000);
    expect(a.amount_raw).toBe("Up to $250,000");
    expect(a.deadline_date).toBe("2026-11-30");
    expect(a.opportunity_type).toBe("accelerator");
  });
  it("ignores non-Funding Forward emails", () => {
    expect(parseFundingForward({ ...email1, subject: "Hello" })).toEqual([]);
  });
});

describe("ingest", () => {
  it("is idempotent for the same message", () => {
    const s = new Store();
    const r1 = ingestEmail(s, email1, now);
    const r2 = ingestEmail(s, email1, now);
    expect(r1.created).toHaveLength(4);
    expect(r1.quarantined).toBe(1); // "Mystery Opportunity" is too thin to trust
    expect(r2.skipped).toBe("already_processed");
    expect(s.grants()).toHaveLength(4);
  });
  it("updates and versions a repeated opportunity instead of duplicating", () => {
    const s = new Store();
    ingestEmail(s, email1, now);
    const r = ingestEmail(s, email2, now);
    expect(r.created).toHaveLength(0);
    expect(r.updated).toHaveLength(1);
    const g = s.state.grants[r.updated[0]!]!;
    expect(g.version).toBe(2);
    expect(g.amount_max_usd).toBe(300000);
    expect(g.deadline_date).toBe("2026-12-07");
    expect(g.source_email_ids).toEqual(["m1", "m2"]);
    const ev = s.state.audit.find((e) => e.kind === "grant.updated")!;
    expect((ev.detail.changes as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("qualification", () => {
  const setup = () => {
    const s = new Store();
    ingestEmail(s, email1, now);
    evaluateAll(s, profile, now);
    const by = (t: string) => s.grants().find((g) => g.title.includes(t))!;
    return { s, by };
  };

  it("auto-archives only on a deterministic, high-confidence disqualifier", () => {
    const { s, by } = setup();
    expect(s.latestEvaluation(by("Startup Founders").id)!.workflow_state).toBe("AUTO_ARCHIVE");
    expect(by("Startup Founders").status).toBe("archived");
    // geography mismatch (CA vs US/NY org): hard fail
    expect(s.latestEvaluation(by("California").id)!.workflow_state).toBe("AUTO_ARCHIVE");
  });

  it("surfaces strong fits for human review and never decides for the human", () => {
    const { s, by } = setup();
    const ev = s.latestEvaluation(by("Accelerator").id)!;
    expect(ev.workflow_state).toBe("REVIEW_STRONG_FIT");
    expect(by("Accelerator").status).toBe("review");
    expect(by("Accelerator").human_decision_id).toBeUndefined();
  });

  it("never auto-archives when eligibility is unknown", () => {
    const s = new Store();
    ingestEmail(s, { ...email2, id: "m9", body: "FUNDING & OPPORTUNITIES\n\nVague Fund https://v.example.org/\nSome money for stuff.\nDeadline: Nov 30\n" }, now);
    evaluateAll(s, profile, now);
    const ev = s.latestEvaluation(s.grants()[0]!.id)!;
    expect(ev.hard_eligibility).toBe("UNKNOWN");
    expect(ev.workflow_state).toBe("REQUEST_RESEARCH");
  });
});

describe("human decisions", () => {
  it("requires an actor, records provenance, and requires a reason to override the AI", () => {
    const s = new Store();
    ingestEmail(s, email1, now);
    evaluateAll(s, profile, now);
    const acc = s.grants().find((g) => g.title.includes("Accelerator"))!;

    expect(() => recordDecision(s, { grantId: acc.id, actorId: "", decision: "PURSUE" })).toThrow(/actor/);
    expect(() => recordDecision(s, { grantId: acc.id, actorId: "sam", decision: "PASS" })).toThrow(/override_reason/);

    const d = recordDecision(s, { grantId: acc.id, actorId: "sam", decision: "PASS", overrideReason: "Cohort overlaps our fall launch." }, now);
    expect(d.override_of_ai).toBe(true);
    expect(s.state.grants[acc.id]!.status).toBe("pass");
    expect(s.state.audit.some((e) => e.kind === "grant.decided" && e.actor === "sam")).toBe(true);
  });

  it("rejects illegal state transitions", () => {
    const s = new Store();
    ingestEmail(s, email1, now);
    const g = s.grants()[0]!;
    recordDecision(s, { grantId: g.id, actorId: "sam", decision: "PURSUE" }, now);
    expect(() => recordDecision(s, { grantId: g.id, actorId: "sam", decision: "RESEARCH_MORE" }, now)).toThrow(/Cannot move/);
  });

  it("counts pursued grants against capacity", () => {
    const s = new Store();
    ingestEmail(s, email1, now);
    const [a] = s.grants();
    recordDecision(s, { grantId: a!.id, actorId: "sam", decision: "PURSUE" }, now);
    expect(s.activeApplications()).toBe(1);
  });
});

describe("real newsletter shape (bullets + UPCOMING DEADLINES + tracking links)", () => {
  const real = (id: string, received: string, body = fx("funding-forward-real-shape.txt")): RawEmail => ({
    id, subject: "Funding Forward: 10/12 - 10/16", received_at: received, body,
  });

  it("parses bullets, merges the deadline list, and never treats tracking links as canonical", () => {
    const cs = parseFundingForward(real("r1", "2026-10-17T10:57:12Z"));
    expect(cs.map((c) => c.title)).toEqual([
      "Example Society: Example Fellowship", "Example Agency: STEM K-12", "Example Fund: Introductory Grants", "Example AI: Open Call",
    ]);
    const [fellow, stem, fund, open] = cs as [typeof cs[0], typeof cs[0], typeof cs[0], typeof cs[0]];
    expect(fellow.funder_name).toBe("Example Society");
    expect(fellow.deadline_date).toBe("2026-11-08"); // from narrative "Apply by"
    expect(stem.deadline_type).toBe("rolling");
    expect([stem.amount_min_usd, stem.amount_max_usd]).toEqual([25000, 750000]);
    expect(fund.deadline_date).toBe("2026-11-01"); // merged from UPCOMING DEADLINES
    expect(fund.source_block_text).toContain("Apply by November 1");
    expect(open.deadline_date).toBe("2026-10-21"); // deadline-only entry still becomes a record
    expect(cs.every((c) => c.source_opportunity_url === undefined && c.source_tracking_url?.includes("hubspotlinks"))).toBe(true);
  });

  it("does not duplicate a repeated opportunity when its tracking link changes", () => {
    const s = new Store();
    ingestEmail(s, real("r1", "2026-10-17T10:57:12Z"), now);
    const next = fx("funding-forward-real-shape.txt").replaceAll("/Ctc/", "/Ctc/NEW-");
    const r = ingestEmail(s, real("r2", "2026-10-18T10:57:12Z", next), now);
    expect(r.created).toHaveLength(0);
    expect(s.grants()).toHaveLength(4);
  });

  it("sends unclassifiable place names to research instead of archiving", () => {
    const s = new Store();
    ingestEmail(s, real("r1", "2026-10-17T10:57:12Z"), now);
    evaluateAll(s, profile, now);
    const fund = s.grants().find((g) => g.title.includes("Introductory"))!;
    const ev = s.latestEvaluation(fund.id)!;
    expect(ev.workflow_state).not.toBe("AUTO_ARCHIVE");
    expect(ev.missing_information).toContain("Geographic eligibility not stated");
    expect(ev.missing_information).toContain("Official opportunity URL missing");
  });
});
