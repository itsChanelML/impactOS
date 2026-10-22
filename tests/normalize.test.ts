import { describe, expect, it } from "vitest";
import { canonicalUrl, classifyType, normalizeGeography, parseAmount, parseDeadline } from "../src/normalize.js";

const ref = new Date("2026-10-01T00:00:00Z");

describe("parseDeadline", () => {
  it("parses month-day and infers the next occurrence", () => {
    expect(parseDeadline("Nov 30", ref)).toEqual({ type: "fixed", date: "2026-11-30" });
    expect(parseDeadline("Jan 5", ref)).toEqual({ type: "fixed", date: "2027-01-05" });
  });
  it("parses numeric and ISO dates", () => {
    expect(parseDeadline("12/15/2026", ref).date).toBe("2026-12-15");
    expect(parseDeadline("2026-11-02", ref).date).toBe("2026-11-02");
  });
  it("recognizes rolling and monthly, and rejects impossible dates", () => {
    expect(parseDeadline("Rolling basis", ref).type).toBe("rolling");
    expect(parseDeadline("Monthly", ref).type).toBe("monthly");
    expect(parseDeadline("Feb 30, 2026", ref).type).toBe("unknown");
    expect(parseDeadline(undefined, ref).type).toBe("unknown");
  });
});

describe("parseAmount", () => {
  it("handles single, up-to, ranges, and suffixes", () => {
    expect(parseAmount("$10,000")).toEqual({ min: 10000, max: 10000 });
    expect(parseAmount("Up to $250,000")).toEqual({ max: 250000 });
    expect(parseAmount("$5K - $25K")).toEqual({ min: 5000, max: 25000 });
    expect(parseAmount("$1.5M")).toEqual({ min: 1.5e6, max: 1.5e6 });
    expect(parseAmount("TBD")).toEqual({});
  });
});

describe("geography/type/url", () => {
  it("normalizes geography tags", () => {
    expect(normalizeGeography("Global")).toEqual(["GLOBAL"]);
    expect(normalizeGeography("NY, New Jersey")).toEqual(["US-NY", "US-NJ"]);
    expect(normalizeGeography("Kenya")).toEqual(["Kenya"]);
  });
  it("classifies types", () => {
    expect(classifyType("Women in Tech Fellowship")).toBe("fellowship");
    expect(classifyType("AI accelerator")).toBe("accelerator");
  });
  it("canonicalizes URLs", () => {
    expect(canonicalUrl("https://www.Example.org/a/?utm_source=x&b=1#frag")).toBe("https://example.org/a?b=1");
    expect(canonicalUrl("not a url")).toBeUndefined();
  });
});
