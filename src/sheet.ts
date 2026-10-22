import type { Store } from "./store.js";

/** Google Sheet projection (spec §13): the Sheet is a view of canonical records, not the source of truth. */
export const SHEET_COLUMNS = [
  "Record ID", "Title", "State/Country", "Type", "Description", "Amount", "Deadline", "Website", "Date Posted",
  "Status", "AI Workflow State", "Hard Eligibility", "Mission Fit", "Population Fit", "Funding Usefulness",
  "Evidence Readiness", "Application Effort", "Deadline Feasibility", "Missing Info", "AI Rationale", "AI Confidence",
  "Human Decision", "Decision By", "Override", "Version", "Last Updated",
] as const;

export function toSheetRows(store: Store): string[][] {
  return store.grants().map((g) => {
    const ev = store.latestEvaluation(g.id);
    const d = g.human_decision_id ? store.state.decisions[g.human_decision_id] : undefined;
    return [
      g.id, g.title, g.geographies.join(", "), g.type, g.description, g.amount_raw ?? "", g.deadline_date ?? g.deadline_raw ?? g.deadline_type,
      g.source_url ?? g.source_link_url ?? "", g.created_at.slice(0, 10), g.status, ev?.workflow_state ?? "", ev?.hard_eligibility ?? "",
      String(ev?.mission_alignment ?? ""), String(ev?.population_alignment ?? ""), String(ev?.funding_usefulness ?? ""),
      String(ev?.evidence_readiness ?? ""), String(ev?.application_effort ?? ""), String(ev?.deadline_feasibility ?? ""),
      ev?.missing_information.join("; ") ?? "", ev?.rationale.join(" ") ?? "", String(ev?.confidence ?? ""),
      d?.decision ?? "", d?.actor_id ?? "", d ? String(d.override_of_ai) : "", String(g.version), g.updated_at,
    ];
  });
}
