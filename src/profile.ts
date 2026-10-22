import { z } from "zod";

/** Organization profile: the configurable "who are we" that qualification runs against. */
export const OrgProfileSchema = z.object({
  version: z.string(),
  name: z.string(),
  /** e.g. "501c3". Opportunities restricted to other applicant classes are hard-disqualified. */
  org_type: z.enum(["501c3", "other_nonprofit", "for_profit", "individual"]).default("501c3"),
  /** Tokens as produced by normalizeGeography: "US", "US-NY", "GLOBAL", country names. */
  geographies: z.array(z.string()).min(1),
  mission_keywords: z.array(z.string()).default([]),
  population_keywords: z.array(z.string()).default([]),
  program_keywords: z.array(z.string()).default([]),
  /** Keywords for which the org already holds approved evidence (metrics, narratives, letters). */
  evidence_keywords: z.array(z.string()).default([]),
  min_amount_usd: z.number().nonnegative().optional(),
  /** Extra deterministic disqualifier regexes: { pattern, reason }. */
  hard_disqualifiers: z.array(z.object({ pattern: z.string(), reason: z.string() })).default([]),
  /** Always route to a senior human, never auto-resolve. */
  sensitive_keywords: z.array(z.string()).default([]),
});
export type OrgProfile = z.infer<typeof OrgProfileSchema>;

export const CapacityConfigSchema = z.object({
  max_active_applications: z.number().int().positive().default(5),
  strong_fit_threshold: z.number().min(0).max(5).default(3.2),
  possible_fit_threshold: z.number().min(0).max(5).default(2.0),
  feasible_capacity_threshold: z.number().min(0).max(1).default(0.25),
  auto_archive_confidence: z.number().min(0).max(1).default(0.95),
});
export type CapacityConfig = z.infer<typeof CapacityConfigSchema>;
