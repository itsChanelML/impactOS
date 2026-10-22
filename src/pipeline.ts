import { findDuplicate } from "./dedupe.js";
import type { CapacityConfig, OrgProfile } from "./profile.js";
import { PARSER_VERSION, isFundingForwardEmail, parseFundingForward } from "./parser.js";
import { evaluate } from "./qualify.js";
import { canTransition, isOverride, statusForDecision, statusForWorkflow } from "./state.js";
import type { Store } from "./store.js";
import type {
  DecisionKind, FieldChange, GrantOpportunity, GrantOpportunityCandidate, HumanDecision, RawEmail,
} from "./types.js";

/** Below this, a candidate goes to the parser-review queue instead of the pipeline (spec §7.2). */
export const MIN_EXTRACTION_CONFIDENCE = 0.5;

export interface IngestResult {
  skipped: "not_funding_forward" | "already_processed" | null;
  created: string[];
  updated: string[];
  quarantined: number;
}

const TRACKED: (keyof GrantOpportunity)[] = [
  "title", "amount_min_usd", "amount_max_usd", "amount_raw", "deadline_date", "deadline_raw", "deadline_type", "description", "eligibility_summary", "source_url",
];

function fromCandidate(c: GrantOpportunityCandidate, id: string, now: string): GrantOpportunity {
  const g: GrantOpportunity = {
    id,
    source_provider: c.source_provider,
    source_email_ids: [c.source_email_id],
    title: c.title,
    type: c.opportunity_type,
    geographies: c.geography_normalized,
    description: c.description,
    deadline_type: c.deadline_type,
    source_conflicts: [],
    status: "new",
    version: 1,
    created_at: now,
    updated_at: now,
  };
  if (c.source_opportunity_url) g.source_url = c.source_opportunity_url;
  if (c.source_tracking_url) g.source_link_url = c.source_tracking_url;
  if (c.funder_name) g.funder_name = c.funder_name;
  if (c.amount_min_usd !== undefined) g.amount_min_usd = c.amount_min_usd;
  if (c.amount_max_usd !== undefined) g.amount_max_usd = c.amount_max_usd;
  if (c.amount_raw) g.amount_raw = c.amount_raw;
  if (c.deadline_date) g.deadline_date = c.deadline_date;
  if (c.deadline_raw) g.deadline_raw = c.deadline_raw;
  if (c.eligibility_summary) g.eligibility_summary = c.eligibility_summary;
  return g;
}

function candidateFields(c: GrantOpportunityCandidate): Partial<GrantOpportunity> {
  const f: Partial<GrantOpportunity> = { title: c.title, description: c.description, deadline_type: c.deadline_type };
  if (c.source_opportunity_url) f.source_url = c.source_opportunity_url;
  if (c.amount_min_usd !== undefined) f.amount_min_usd = c.amount_min_usd;
  if (c.amount_max_usd !== undefined) f.amount_max_usd = c.amount_max_usd;
  if (c.amount_raw) f.amount_raw = c.amount_raw;
  if (c.deadline_date) f.deadline_date = c.deadline_date;
  if (c.deadline_raw) f.deadline_raw = c.deadline_raw;
  if (c.eligibility_summary) f.eligibility_summary = c.eligibility_summary;
  return f;
}

/** Idempotent: re-ingesting the same message with the same parser version is a no-op (spec §23.11). */
export function ingestEmail(store: Store, email: RawEmail, now = new Date()): IngestResult {
  const result: IngestResult = { skipped: null, created: [], updated: [], quarantined: 0 };
  const key = `${email.id}@${PARSER_VERSION}`;
  const at = now.toISOString();

  if (!isFundingForwardEmail(email)) return { ...result, skipped: "not_funding_forward" };
  if (store.state.processed[key]) return { ...result, skipped: "already_processed" };

  let candidates: GrantOpportunityCandidate[];
  try {
    candidates = parseFundingForward(email);
  } catch (err) {
    // Never silently lose an email: record the failure; message is NOT marked processed so it can be retried.
    store.log({ at, kind: "parse.failed", actor: "system", detail: { email_id: email.id, error: String(err) } });
    store.save();
    throw err;
  }

  for (const c of candidates) {
    if (c.extraction_confidence < MIN_EXTRACTION_CONFIDENCE) {
      const q = { id: store.nextId("q"), source_email_id: email.id, block_text: c.source_block_text, reason: c.extraction_warnings.join("; ") || "low confidence", at };
      store.state.quarantine.push(q);
      store.log({ at, kind: "parse.quarantined", actor: "system", detail: { quarantine_id: q.id, email_id: email.id } });
      result.quarantined++;
      continue;
    }
    const dup = findDuplicate(c, store.grants());
    if (dup) {
      const g = dup.grant;
      if (!g.source_email_ids.includes(email.id)) g.source_email_ids.push(email.id);
      const next = candidateFields(c);
      const changes: FieldChange[] = [];
      for (const f of TRACKED) {
        const to = next[f];
        if (to !== undefined && JSON.stringify(g[f]) !== JSON.stringify(to)) {
          changes.push({ field: f, from: g[f], to });
          (g as unknown as Record<string, unknown>)[f] = to;
        }
      }
      if (changes.length) {
        g.version++;
        g.updated_at = at;
        store.log({ at, grant_id: g.id, kind: "grant.updated", actor: "system", detail: { email_id: email.id, match: dup.kind, changes } });
        result.updated.push(g.id);
      } else {
        store.log({ at, grant_id: g.id, kind: "grant.duplicate_seen", actor: "system", detail: { email_id: email.id, match: dup.kind } });
      }
      continue;
    }
    const g = fromCandidate(c, store.nextId("grant"), at);
    store.state.grants[g.id] = g;
    store.log({ at, grant_id: g.id, kind: "grant.created", actor: "system", detail: { email_id: email.id, extraction_confidence: c.extraction_confidence, warnings: c.extraction_warnings } });
    result.created.push(g.id);
  }

  store.state.processed[key] = true;
  store.log({ at, kind: "email.processed", actor: "system", detail: { email_id: email.id, ...result } });
  store.save();
  return result;
}

export function evaluateGrant(
  store: Store, grantId: string, profile: OrgProfile, now = new Date(), config?: Partial<CapacityConfig>,
) {
  const g = store.state.grants[grantId];
  if (!g) throw new Error(`Unknown grant ${grantId}`);
  const ev = { id: store.nextId("eval"), ...evaluate({ grant: g, profile, activeApplications: store.activeApplications(), now, ...(config ? { config } : {}) }) };
  store.state.evaluations[ev.id] = ev;
  g.evaluation_id = ev.id;
  g.updated_at = now.toISOString();
  store.log({ at: ev.evaluated_at, grant_id: g.id, kind: "grant.evaluated", actor: ev.evaluator_id, detail: { evaluation_id: ev.id, workflow_state: ev.workflow_state } });

  // Only advance records the humans have not yet touched.
  if (g.status === "new" || g.status === "research" || g.status === "review") {
    const to = statusForWorkflow(ev.workflow_state);
    if (to !== g.status && canTransition(g.status, to)) {
      store.log({ at: ev.evaluated_at, grant_id: g.id, kind: "grant.status_changed", actor: ev.evaluator_id, detail: { from: g.status, to } });
      g.status = to;
    }
  }
  store.save();
  return ev;
}

export function evaluateAll(store: Store, profile: OrgProfile, now = new Date(), config?: Partial<CapacityConfig>) {
  return store.grants().filter((g) => g.status === "new").map((g) => evaluateGrant(store, g.id, profile, now, config));
}

export interface DecisionInput {
  grantId: string;
  actorId: string;
  decision: DecisionKind;
  rationale?: string;
  overrideReason?: string;
}

/**
 * The human gate. Only this function moves a grant to pursue/pass.
 * Overrides of the AI recommendation require a reason (spec §23.9).
 */
export function recordDecision(store: Store, input: DecisionInput, now = new Date()): HumanDecision {
  const g = store.state.grants[input.grantId];
  if (!g) throw new Error(`Unknown grant ${input.grantId}`);
  if (!input.actorId.trim()) throw new Error("actor_id is required: decisions must be attributable to a person");
  const ev = store.latestEvaluation(g.id);
  const override = isOverride(ev?.workflow_state, input.decision);
  if (override && !input.overrideReason?.trim()) throw new Error(`Decision ${input.decision} overrides AI state ${ev?.workflow_state}; override_reason is required`);

  const to = statusForDecision(input.decision);
  if (to !== g.status && !canTransition(g.status, to)) throw new Error(`Cannot move grant from ${g.status} to ${to}`);

  const d: HumanDecision = {
    id: store.nextId("dec"), grant_id: g.id, actor_id: input.actorId, decision: input.decision,
    override_of_ai: override, decided_at: now.toISOString(),
    ...(input.rationale ? { rationale: input.rationale } : {}),
    ...(input.overrideReason ? { override_reason: input.overrideReason } : {}),
  };
  store.state.decisions[d.id] = d;
  g.human_decision_id = d.id;
  const from = g.status;
  g.status = to;
  g.updated_at = d.decided_at;
  store.log({ at: d.decided_at, grant_id: g.id, kind: "grant.decided", actor: input.actorId, detail: { decision_id: d.id, decision: d.decision, override_of_ai: override, from, to } });
  store.save();
  return d;
}
