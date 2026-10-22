import type { CapacityConfig, OrgProfile } from "./profile.js";
import { CapacityConfigSchema } from "./profile.js";
import type {
  CapacitySnapshot, EvidenceRef, GrantEvaluation, GrantOpportunity, HardEligibility, WorkflowState,
} from "./types.js";

export const EVALUATOR_ID = "impactos-rules-0.1.0";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r1 = (n: number) => Math.round(n * 10) / 10;

function haystack(g: GrantOpportunity): string {
  return `${g.title} ${g.description} ${g.eligibility_summary ?? ""}`.toLowerCase();
}

/** 0..5 by distinct keyword hits (3+ hits = 5). Returns matched keywords for the rationale. */
function keywordScore(text: string, kws: string[]): { score: number; hits: string[] } {
  const hits = kws.filter((k) => text.includes(k.toLowerCase()));
  return { score: r1(clamp((hits.length / 3) * 5, 0, 5)), hits };
}

function geographyCompatible(grantGeos: string[], orgGeos: string[]): boolean | undefined {
  if (grantGeos.length === 0) return undefined;
  if (grantGeos.includes("GLOBAL")) return true;
  const org = new Set(orgGeos);
  return grantGeos.some((g) => org.has(g) || (g.startsWith("US-") && org.has("US") && org.has(g)) || (g === "US" && [...org].some((o) => o === "US" || o.startsWith("US-"))));
}

interface EligibilityResult {
  verdict: HardEligibility;
  confidence: number;
  reasons: EvidenceRef[];
  missing: string[];
}

/**
 * Hard eligibility is deterministic. FAIL requires an explicit rule hit;
 * anything unestablished is UNKNOWN and is never auto-archived (spec §23.5-6).
 */
export function assessEligibility(g: GrantOpportunity, p: OrgProfile): EligibilityResult {
  const text = haystack(g);
  const reasons: EvidenceRef[] = [];
  const missing: string[] = [];

  const fail = (statement: string, confidence: number): EligibilityResult => {
    reasons.push({ label: "SOURCE_FACT", statement, source: g.source_url ?? g.source_email_ids[0] });
    return { verdict: "FAIL", confidence, reasons, missing };
  };

  if (p.org_type !== "for_profit" && /\bfor-?profit (companies|businesses|startups?|only)\b|\bstartups? only\b|\bcompanies only\b|\bincorporated (c-corp|llc)\b/.test(text))
    return fail("Opportunity is restricted to for-profit entities; organization is a nonprofit.", 0.97);
  if (p.org_type !== "individual" && /\bindividuals? only\b|\bopen to individuals\b/.test(text) && !/nonprofit|organization/.test(text))
    return fail("Opportunity is restricted to individual applicants.", 0.96);
  for (const d of p.hard_disqualifiers) {
    if (new RegExp(d.pattern, "i").test(text)) return fail(d.reason, 0.97);
  }

  const geo = geographyCompatible(g.geographies, p.geographies);
  if (geo === false) return fail(`Geography ${g.geographies.join(", ")} does not include ${p.geographies.join(", ")}.`, 0.95);
  if (geo === undefined) missing.push("Geographic eligibility not stated");
  else reasons.push({ label: "SOURCE_FACT", statement: `Geography ${g.geographies.join(", ")} is compatible.`, source: g.source_email_ids[0] });

  const nonprofitSignal = /non-?profit|501\(?c\)?\(?3\)?|\bngo\b|charit|community organization|\borganizations?\b/.test(text);
  if (!nonprofitSignal) missing.push("Applicant type (nonprofit eligibility) not stated");
  else reasons.push({ label: "SOURCE_FACT", statement: "Source text indicates organizations/nonprofits may apply.", source: g.source_email_ids[0] });

  if (g.deadline_type === "unknown") missing.push("Deadline not established");
  if (g.source_conflicts.length) missing.push("Source conflict unresolved");

  return missing.some((m) => /Geographic|Applicant type/.test(m))
    ? { verdict: "UNKNOWN", confidence: 0.5, reasons, missing }
    : { verdict: "PASS", confidence: 0.8, reasons, missing };
}

export function capacitySnapshot(activeApplications: number, cfg: CapacityConfig): CapacitySnapshot {
  const score = clamp(1 - activeApplications / cfg.max_active_applications, 0, 1);
  return { active_applications: activeApplications, max_active_applications: cfg.max_active_applications, score: r1(score * 100) / 100 };
}

const EFFORT_BY_TYPE: Record<string, number> = {
  grant: 3, fellowship: 4, accelerator: 4, pitch_competition: 3, in_kind: 2, credit: 1, resource: 1, other: 3,
};

export interface EvaluateInput {
  grant: GrantOpportunity;
  profile: OrgProfile;
  activeApplications: number;
  now: Date;
  config?: Partial<CapacityConfig>;
}

/** Pure, deterministic first-pass evaluation. LLM judgments plug in by supplying evaluations of the same shape. */
export function evaluate(input: EvaluateInput): Omit<GrantEvaluation, "id"> {
  const { grant: g, profile: p, now } = input;
  const cfg = CapacityConfigSchema.parse(input.config ?? {});
  const text = haystack(g);
  const cap = capacitySnapshot(input.activeApplications, cfg);
  const rationale: string[] = [];
  const conflicts = [...g.source_conflicts];

  const elig = assessEligibility(g, p);

  const mission = keywordScore(text, [...p.mission_keywords, ...p.program_keywords]);
  const population = keywordScore(text, p.population_keywords);
  const evidence = keywordScore(text, p.evidence_keywords);

  const max = g.amount_max_usd;
  let usefulness = 2.5;
  if (max === undefined) usefulness = 2;
  else if (p.min_amount_usd && max < p.min_amount_usd) usefulness = 0.5;
  else usefulness = clamp(Math.log10(Math.max(max, 1)) - 1.5, 0.5, 5);
  usefulness = r1(usefulness);

  const effort = EFFORT_BY_TYPE[g.type] ?? 3;

  let feasibility = 3;
  let daysLeft: number | undefined;
  if (g.deadline_type === "fixed" && g.deadline_date) {
    daysLeft = Math.ceil((Date.parse(g.deadline_date) - now.getTime()) / 864e5);
    feasibility = daysLeft < 0 ? 0 : clamp((daysLeft / (effort * 7)) * 3, 0, 5);
  } else if (g.deadline_type === "rolling") feasibility = 4;
  feasibility = r1(feasibility);

  const leverage = r1(clamp((g.type === "fellowship" || g.type === "accelerator" ? 3 : 2) + (mission.score >= 4 ? 1 : 0) + (g.geographies.includes("GLOBAL") ? 0 : 0.5), 0, 5));
  const reporting = g.type === "grant" ? 3 : g.type === "resource" || g.type === "credit" ? 1 : 2;

  const sensitive = p.sensitive_keywords.filter((k) => text.includes(k.toLowerCase()));
  const closed = daysLeft !== undefined && daysLeft < 0;

  if (mission.hits.length) rationale.push(`Mission/program keywords matched: ${mission.hits.join(", ")}.`);
  else rationale.push("No mission/program keywords matched in the source text.");
  if (population.hits.length) rationale.push(`Population keywords matched: ${population.hits.join(", ")}.`);
  if (daysLeft !== undefined) rationale.push(closed ? "Deadline has passed." : `${daysLeft} day(s) until deadline; effort class ${effort}/5.`);
  rationale.push(`Capacity: ${cap.active_applications}/${cap.max_active_applications} active applications.`);

  const fit = r1((mission.score * 2 + population.score + usefulness + leverage) / 5);
  const missing = [...elig.missing];
  if (g.amount_max_usd === undefined) missing.push("Award amount not stated");
  if (!g.source_url) missing.push("Official opportunity URL missing");

  let state: WorkflowState;
  if (elig.verdict === "FAIL" && elig.confidence >= cfg.auto_archive_confidence) {
    state = "AUTO_ARCHIVE";
    rationale.push(...elig.reasons.map((r) => r.statement));
  } else if (conflicts.length || sensitive.length) {
    state = "ESCALATE";
    if (sensitive.length) rationale.push(`Sensitive terms present (${sensitive.join(", ")}); needs senior review.`);
  } else if (elig.verdict === "UNKNOWN") {
    state = "REQUEST_RESEARCH";
    rationale.push("Hard eligibility is unknown; verify against the official page before deciding.");
  } else if (closed) {
    state = "REVIEW_LOW_FIT";
  } else if (fit >= cfg.strong_fit_threshold && cap.score >= cfg.feasible_capacity_threshold) {
    state = "REVIEW_STRONG_FIT";
  } else if (fit >= cfg.possible_fit_threshold) {
    state = "REQUEST_RESEARCH";
    rationale.push(cap.score < cfg.feasible_capacity_threshold ? "Possible fit but team capacity is tight." : "Possible fit; more evidence needed.");
  } else {
    state = "REVIEW_LOW_FIT"; // human-visible; never silently discarded
  }

  const confidence = state === "AUTO_ARCHIVE" ? elig.confidence : r1(Math.min(elig.confidence, 0.9) * 100) / 100;

  return {
    grant_id: g.id,
    org_profile_version: p.version,
    capacity_snapshot: cap,
    evaluated_at: now.toISOString(),
    evaluator_id: EVALUATOR_ID,
    hard_eligibility: elig.verdict,
    eligibility_reasons: elig.reasons,
    mission_alignment: mission.score,
    population_alignment: population.score,
    funding_usefulness: usefulness,
    evidence_readiness: evidence.score,
    application_effort: effort,
    deadline_feasibility: feasibility,
    reporting_burden: reporting,
    strategic_leverage: leverage,
    workflow_state: state,
    rationale,
    missing_information: missing,
    conflicts,
    confidence,
  };
}
