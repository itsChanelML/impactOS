export const OPPORTUNITY_TYPES = [
  "grant", "fellowship", "accelerator", "pitch_competition",
  "in_kind", "credit", "resource", "other",
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export type DeadlineType = "fixed" | "rolling" | "monthly" | "unknown";

/** Parser output contract (spec §7.3). */
export interface GrantOpportunityCandidate {
  source_email_id: string;
  source_email_subject: string;
  source_received_at: string;
  source_provider: "Fast Forward";
  source_block_text: string;
  source_opportunity_url?: string;
  /** Click-tracking redirect from the newsletter; for humans only, never used for dedupe. */
  source_tracking_url?: string;

  title: string;
  funder_name?: string;
  geography_raw?: string;
  geography_normalized: string[];
  opportunity_type: OpportunityType;
  description: string;
  amount_raw?: string;
  amount_min_usd?: number;
  amount_max_usd?: number;
  deadline_raw?: string;
  deadline_date?: string;
  deadline_type: DeadlineType;
  eligibility_summary?: string;

  extraction_confidence: number;
  extraction_warnings: string[];
  parser_version: string;
}

export type GrantStatus =
  | "new" | "research" | "review" | "pursue" | "pass"
  | "applied" | "awarded" | "declined" | "withdrawn" | "closed" | "archived";

export type WorkflowState =
  | "AUTO_ARCHIVE" | "REVIEW_STRONG_FIT" | "REVIEW_LOW_FIT"
  | "REQUEST_RESEARCH" | "ESCALATE";

export type HardEligibility = "PASS" | "FAIL" | "UNKNOWN";

/** Evidence taxonomy (spec §10.1). */
export type EvidenceLabel =
  | "SOURCE_FACT" | "ORGANIZATION_FACT" | "CLAIM"
  | "MODEL_INFERENCE" | "MISSING" | "CONFLICT";

export interface EvidenceRef {
  label: EvidenceLabel;
  statement: string;
  source?: string;
}

export interface GrantEvaluation {
  id: string;
  grant_id: string;
  org_profile_version: string;
  capacity_snapshot: CapacitySnapshot;
  evaluated_at: string;
  evaluator_id: string;
  hard_eligibility: HardEligibility;
  eligibility_reasons: EvidenceRef[];
  mission_alignment: number;
  population_alignment: number;
  funding_usefulness: number;
  evidence_readiness: number;
  application_effort: number;
  deadline_feasibility: number;
  reporting_burden: number;
  strategic_leverage: number;
  workflow_state: WorkflowState;
  rationale: string[];
  missing_information: string[];
  conflicts: string[];
  confidence: number;
}

export interface CapacitySnapshot {
  active_applications: number;
  max_active_applications: number;
  score: number; // 0..1, higher = more room
}

export type DecisionKind = "PURSUE" | "PASS" | "RESEARCH_MORE" | "ESCALATE";

export interface HumanDecision {
  id: string;
  grant_id: string;
  actor_id: string;
  decision: DecisionKind;
  rationale?: string;
  override_of_ai: boolean;
  override_reason?: string;
  decided_at: string;
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface AuditEvent {
  id: string;
  at: string;
  grant_id?: string;
  kind:
    | "grant.created" | "grant.updated" | "grant.duplicate_seen"
    | "grant.evaluated" | "grant.decided" | "grant.status_changed"
    | "email.processed" | "parse.quarantined" | "parse.failed";
  actor: string;
  detail: Record<string, unknown>;
}

/** Canonical record (spec §12.1). */
export interface GrantOpportunity {
  id: string;
  source_provider: string;
  source_email_ids: string[];
  source_url?: string;
  source_link_url?: string;
  title: string;
  funder_name?: string;
  type: OpportunityType;
  geographies: string[];
  description: string;
  amount_min_usd?: number;
  amount_max_usd?: number;
  amount_raw?: string;
  deadline_date?: string;
  deadline_raw?: string;
  deadline_type: DeadlineType;
  eligibility_summary?: string;
  source_conflicts: string[];
  status: GrantStatus;
  evaluation_id?: string;
  human_decision_id?: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface QuarantinedBlock {
  id: string;
  source_email_id: string;
  block_text: string;
  reason: string;
  at: string;
}

export interface RawEmail {
  id: string;
  subject: string;
  from?: string;
  received_at: string;
  body: string;
}
