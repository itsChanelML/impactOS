import type { Store } from "./store.js";
import type { GrantEvaluation, GrantOpportunity, HumanDecision } from "./types.js";

/**
 * Google Sheet projection (spec §13). The Sheet is a view of canonical records, not the source of truth.
 * SYSTEM columns are written by ImpactOS. HUMAN columns are typed by the team and read back by sync.
 * Columns are matched by header name, so teams may reorder them or add their own.
 */
export interface RowContext {
  grant: GrantOpportunity;
  evaluation?: GrantEvaluation;
  decision?: HumanDecision;
}

export interface SystemColumn {
  header: string;
  value: (c: RowContext) => string;
}

const n = (v: number | undefined) => (v === undefined ? "" : String(v));

export const SYSTEM_COLUMNS: SystemColumn[] = [
  { header: "Record ID", value: (c) => c.grant.id },
  { header: "Title", value: (c) => c.grant.title },
  { header: "Funder", value: (c) => c.grant.funder_name ?? "" },
  { header: "State/Country", value: (c) => c.grant.geographies.join(", ") },
  { header: "Type", value: (c) => c.grant.type },
  { header: "Description", value: (c) => c.grant.description },
  { header: "Amount", value: (c) => c.grant.amount_raw ?? "" },
  { header: "Deadline", value: (c) => c.grant.deadline_date ?? c.grant.deadline_raw ?? c.grant.deadline_type },
  { header: "Website", value: (c) => c.grant.source_url ?? c.grant.source_link_url ?? "" },
  { header: "Date Posted", value: (c) => c.grant.created_at.slice(0, 10) },
  { header: "Status", value: (c) => c.grant.status },
  { header: "AI Workflow State", value: (c) => c.evaluation?.workflow_state ?? "" },
  { header: "Hard Eligibility", value: (c) => c.evaluation?.hard_eligibility ?? "" },
  { header: "Mission Fit", value: (c) => n(c.evaluation?.mission_alignment) },
  { header: "Population Fit", value: (c) => n(c.evaluation?.population_alignment) },
  { header: "Funding Usefulness", value: (c) => n(c.evaluation?.funding_usefulness) },
  { header: "Evidence Readiness", value: (c) => n(c.evaluation?.evidence_readiness) },
  { header: "Application Effort", value: (c) => n(c.evaluation?.application_effort) },
  { header: "Deadline Feasibility", value: (c) => n(c.evaluation?.deadline_feasibility) },
  { header: "Missing Info", value: (c) => c.evaluation?.missing_information.join("; ") ?? "" },
  { header: "AI Rationale", value: (c) => c.evaluation?.rationale.join(" ") ?? "" },
  { header: "AI Confidence", value: (c) => n(c.evaluation?.confidence) },
  { header: "Source Email IDs", value: (c) => c.grant.source_email_ids.join(", ") },
  { header: "Version", value: (c) => String(c.grant.version) },
  { header: "Last Updated", value: (c) => c.grant.updated_at },
];

/** Written by sync itself (per-row result of reading the human columns). */
export const SYNC_STATUS_HEADER = "Sync Status";

export const HUMAN = {
  owner: "Owner",
  decision: "Human Decision",
  decisionBy: "Decision By",
  rationale: "Decision Rationale",
  overrideReason: "Override Reason",
} as const;
export const HUMAN_HEADERS: string[] = Object.values(HUMAN);
export const DECISION_VALUES = ["PURSUE", "PASS", "RESEARCH_MORE", "ESCALATE"] as const;

export const SYSTEM_HEADERS: string[] = [...SYSTEM_COLUMNS.map((c) => c.header), SYNC_STATUS_HEADER];
export const SHEET_COLUMNS: string[] = [...SYSTEM_HEADERS, ...HUMAN_HEADERS];

export function humanValues(c: RowContext): Record<string, string> {
  return {
    [HUMAN.owner]: c.grant.owner ?? "",
    [HUMAN.decision]: c.decision?.decision ?? "",
    [HUMAN.decisionBy]: c.decision?.actor_id ?? "",
    [HUMAN.rationale]: c.decision?.rationale ?? "",
    [HUMAN.overrideReason]: c.decision?.override_reason ?? "",
  };
}

export function contextFor(store: Store, g: GrantOpportunity): RowContext {
  const evaluation = store.latestEvaluation(g.id);
  const decision = store.latestDecision(g.id);
  return { grant: g, ...(evaluation ? { evaluation } : {}), ...(decision ? { decision } : {}) };
}

/** Plain rows in SHEET_COLUMNS order (used by `export-sheet`). */
export function toSheetRows(store: Store): string[][] {
  return store.grants().map((g) => {
    const ctx = contextFor(store, g);
    const human = humanValues(ctx);
    return SHEET_COLUMNS.map((h) => SYSTEM_COLUMNS.find((c) => c.header === h)?.value(ctx) ?? human[h] ?? "");
  });
}
