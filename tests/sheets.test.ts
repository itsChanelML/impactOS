import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { GoogleSheetsClient, colLetter } from "../src/google-sheets.js";
import { evaluateAll, ingestEmail, recordDecision } from "../src/pipeline.js";
import { OrgProfileSchema } from "../src/profile.js";
import { HUMAN } from "../src/sheet.js";
import { syncSheet, type SheetsClient } from "../src/sheets-sync.js";
import { Store } from "../src/store.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const profile = OrgProfileSchema.parse(JSON.parse(readFileSync(new URL("../examples/profile.json", import.meta.url), "utf8")));
const now = new Date("2026-10-20T12:00:00Z");

class FakeSheet implements SheetsClient {
  grid: string[][] = [];
  writes = 0;
  async getValues() { return this.grid.map((r) => [...r]); }
  async writeCells(_tab: string, cells: { row: number; col: number; value: string }[]) {
    for (const c of cells) {
      while (this.grid.length < c.row) this.grid.push([]);
      const r = this.grid[c.row - 1]!;
      while (r.length < c.col) r.push("");
      r[c.col - 1] = c.value;
      this.writes++;
    }
  }
  col(h: string) { return this.grid[0]!.indexOf(h); }
  get(row: number, h: string) { return this.grid[row - 1]?.[this.col(h)] ?? ""; }
  set(row: number, h: string, v: string) {
    const r = this.grid[row - 1]!;
    while (r.length <= this.col(h)) r.push("");
    r[this.col(h)] = v;
  }
  rowOfTitle(t: string) { return this.grid.findIndex((r) => r[this.col("Title")]?.includes(t)) + 1; }
}

let store: Store, sheet: FakeSheet;
beforeEach(() => {
  store = new Store();
  ingestEmail(store, { id: "m1", subject: "Funding Forward: 10/19 - 10/23", received_at: "2026-10-19T12:00:00Z", body: fx("funding-forward-1.txt") }, now);
  evaluateAll(store, profile, now);
  sheet = new FakeSheet();
});

describe("syncSheet: push", () => {
  it("writes headers and one row per grant, matched by Record ID", async () => {
    const r = await syncSheet(store, sheet, "Pipeline", now);
    expect(r.appended).toBe(4);
    expect(sheet.grid).toHaveLength(5);
    const row = sheet.rowOfTitle("Accelerator");
    expect(sheet.get(row, "AI Workflow State")).toBe("REVIEW_STRONG_FIT");
    expect(sheet.get(row, "Record ID")).toMatch(/^grant_/);
  });

  it("is idempotent: a second sync writes nothing", async () => {
    await syncSheet(store, sheet, "Pipeline", now);
    const r = await syncSheet(store, sheet, "Pipeline", now);
    expect(r.cellsWritten).toBe(0);
    expect(r.appended).toBe(0);
  });

  it("follows the team's column order and keeps their extra columns", async () => {
    await syncSheet(store, sheet, "Pipeline", now);
    // team moves Title to the far end and adds a private column
    const t = sheet.col("Title");
    const width = sheet.grid[0]!.length;
    for (const row of sheet.grid) while (row.length < width) row.push("");
    for (const row of sheet.grid) { const [v] = row.splice(t, 1); row.push(v ?? ""); }
    sheet.grid[0]!.push("Team Notes");
    sheet.grid[2]!.push("call funder first");
    const r = await syncSheet(store, sheet, "Pipeline", now);
    expect(r.cellsWritten).toBe(0);
    expect(sheet.grid[2]!.at(-1)).toBe("call funder first");
  });

  it("updates a changed record in place instead of appending", async () => {
    await syncSheet(store, sheet, "Pipeline", now);
    ingestEmail(store, { id: "m2", subject: "Funding Forward: 10/26 - 10/30", received_at: "2026-10-26T12:00:00Z", body: fx("funding-forward-2.txt") }, now);
    const r = await syncSheet(store, sheet, "Pipeline", now);
    expect(r.appended).toBe(0);
    expect(sheet.get(sheet.rowOfTitle("Accelerator"), "Version")).toBe("2");
  });
});

describe("syncSheet: pull human columns", () => {
  const row = () => sheet.rowOfTitle("Accelerator");
  const grant = () => store.grants().find((g) => g.title.includes("Accelerator"))!;

  it("applies a decision typed in the Sheet, with attribution and audit", async () => {
    await syncSheet(store, sheet, "Pipeline", now);
    sheet.set(row(), HUMAN.decision, "pursue");
    sheet.set(row(), HUMAN.decisionBy, "sam");
    sheet.set(row(), HUMAN.rationale, "Fits fall launch");
    const r = await syncSheet(store, sheet, "Pipeline", now);
    expect(r.decisionsApplied).toBe(1);
    expect(grant().status).toBe("pursue");
    expect(store.latestDecision(grant().id)).toMatchObject({ decision: "PURSUE", actor_id: "sam", rationale: "Fits fall launch" });
    expect(sheet.get(row(), "Status")).toBe("pursue");
    expect(sheet.get(row(), "Sync Status")).toBe("");
  });

  it("rejects a decision with no 'Decision By' and leaves the human's cell alone", async () => {
    await syncSheet(store, sheet, "Pipeline", now);
    sheet.set(row(), HUMAN.decision, "PURSUE");
    const r = await syncSheet(store, sheet, "Pipeline", now);
    expect(r.rejected).toHaveLength(1);
    expect(grant().status).toBe("review");
    expect(sheet.get(row(), HUMAN.decision)).toBe("PURSUE");
    expect(sheet.get(row(), "Sync Status")).toMatch(/Decision By/);
  });

  it("rejects invalid values and AI overrides without a reason; accepts once fixed", async () => {
    await syncSheet(store, sheet, "Pipeline", now);
    sheet.set(row(), HUMAN.decision, "maybe");
    sheet.set(row(), HUMAN.decisionBy, "sam");
    await syncSheet(store, sheet, "Pipeline", now);
    expect(sheet.get(row(), "Sync Status")).toMatch(/not valid/);

    sheet.set(row(), HUMAN.decision, "PASS"); // overrides REVIEW_STRONG_FIT
    await syncSheet(store, sheet, "Pipeline", now);
    expect(sheet.get(row(), "Sync Status")).toMatch(/override_reason/);
    expect(grant().status).toBe("review");

    sheet.set(row(), HUMAN.overrideReason, "Cohort overlaps launch");
    const r = await syncSheet(store, sheet, "Pipeline", now);
    expect(r.decisionsApplied).toBe(1);
    expect(grant().status).toBe("pass");
    expect(store.latestDecision(grant().id)!.override_of_ai).toBe(true);
    expect(sheet.get(row(), "Sync Status")).toBe("");
  });

  it("fills the Sheet from a decision recorded elsewhere (CLI), and never overwrites a human's pending edit", async () => {
    await syncSheet(store, sheet, "Pipeline", now);
    recordDecision(store, { grantId: grant().id, actorId: "jo", decision: "PURSUE" }, now);
    await syncSheet(store, sheet, "Pipeline", now);
    expect(sheet.get(row(), HUMAN.decision)).toBe("PURSUE");
    expect(sheet.get(row(), HUMAN.decisionBy)).toBe("jo");
  });

  it("takes the Owner typed in the Sheet", async () => {
    await syncSheet(store, sheet, "Pipeline", now);
    sheet.set(row(), HUMAN.owner, "Priya");
    const r = await syncSheet(store, sheet, "Pipeline", now);
    expect(r.ownersApplied).toBe(1);
    expect(grant().owner).toBe("Priya");
  });
});

describe("GoogleSheetsClient", () => {
  it("converts column numbers to letters", () => {
    expect([1, 26, 27, 52, 53].map(colLetter)).toEqual(["A", "Z", "AA", "AZ", "BA"]);
  });

  it("writes literal text (RAW) so newsletter content can never run as a formula", async () => {
    const calls: { url: string; body: any }[] = [];
    const client = new GoogleSheetsClient({
      spreadsheetId: "SID", getToken: async () => "tok",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.writeCells("My Tab", [{ row: 2, col: 28, value: "=IMPORTDATA(\"http://evil\")" }]);
    expect(calls[0]!.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/SID/values:batchUpdate");
    expect(calls[0]!.body.valueInputOption).toBe("RAW");
    expect(calls[0]!.body.data[0].range).toBe("'My Tab'!AB2");
  });

  it("explains a 403 as a sharing problem", async () => {
    const client = new GoogleSheetsClient({
      spreadsheetId: "SID", getToken: async () => "tok",
      fetchImpl: (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(client.getValues("Pipeline")).rejects.toThrow(/shared with the service account/);
  });
});
