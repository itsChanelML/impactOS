import { canonicalUrl } from "./normalize.js";
import type { GrantOpportunity, GrantOpportunityCandidate } from "./types.js";

const STOP = new Set(["the", "a", "an", "of", "for", "and", "to", "in", "on", "program", "grant", "grants", "fund"]);

export function titleTokens(t: string): Set<string> {
  return new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export type MatchKind = "url" | "title+deadline" | "title+deadline+amount";
export interface DuplicateMatch {
  grant: GrantOpportunity;
  kind: MatchKind;
}

function daysApart(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  return Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
}

/**
 * Spec §7.4 priority order. Model-assisted matching is intentionally absent:
 * ambiguous cases are inserted as new records rather than merged automatically.
 */
export function findDuplicate(c: GrantOpportunityCandidate, existing: GrantOpportunity[]): DuplicateMatch | undefined {
  const url = canonicalUrl(c.source_opportunity_url);
  if (url) {
    const hit = existing.find((g) => canonicalUrl(g.source_url) === url);
    if (hit) return { grant: hit, kind: "url" };
  }
  const tokens = titleTokens(c.title);
  for (const g of existing) {
    if (jaccard(tokens, titleTokens(g.title)) < 0.8) continue;
    const gap = daysApart(c.deadline_date, g.deadline_date);
    if (g.funder_name && c.funder_name && g.funder_name.toLowerCase() === c.funder_name.toLowerCase() && (gap === undefined || gap <= 14))
      return { grant: g, kind: "title+deadline" };
    if (gap !== undefined && gap <= 7 && g.amount_max_usd === c.amount_max_usd)
      return { grant: g, kind: "title+deadline+amount" };
    if (gap === 0 && !g.funder_name) return { grant: g, kind: "title+deadline" };
  }
  return undefined;
}
