import type { DecisionKind, GrantStatus, WorkflowState } from "./types.js";

/** Allowed status transitions (spec §20.2). Writes outside this graph are rejected. */
export const TRANSITIONS: Record<GrantStatus, GrantStatus[]> = {
  new: ["research", "review", "pursue", "pass", "archived", "closed"],
  research: ["review", "pursue", "pass", "closed"],
  review: ["research", "pursue", "pass", "closed"],
  pursue: ["applied", "pass", "withdrawn", "closed"],
  pass: ["review", "closed"],
  applied: ["awarded", "declined", "withdrawn"],
  awarded: [],
  declined: [],
  withdrawn: [],
  closed: [],
  archived: ["review"],
};

export function canTransition(from: GrantStatus, to: GrantStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function statusForWorkflow(s: WorkflowState): GrantStatus {
  switch (s) {
    case "AUTO_ARCHIVE": return "archived";
    case "REQUEST_RESEARCH": return "research";
    default: return "review";
  }
}

export function statusForDecision(d: DecisionKind): GrantStatus {
  switch (d) {
    case "PURSUE": return "pursue";
    case "PASS": return "pass";
    case "RESEARCH_MORE": return "research";
    case "ESCALATE": return "review";
  }
}

/** Does the human decision disagree with what the AI recommended? */
export function isOverride(ai: WorkflowState | undefined, d: DecisionKind): boolean {
  if (!ai) return false;
  if (ai === "REVIEW_STRONG_FIT") return d === "PASS";
  if (ai === "AUTO_ARCHIVE" || ai === "REVIEW_LOW_FIT") return d === "PURSUE";
  return false;
}
