import { canonicalUrl, classifyType, normalizeGeography, parseAmount, parseDeadline } from "./normalize.js";
import type { GrantOpportunityCandidate, RawEmail } from "./types.js";

export const PARSER_VERSION = "fastforward-0.1.0";

const SECTION_START = /^\s*#*\s*funding\s*(?:&|and)\s*opportunities\s*$/i;
// A new all-caps heading (e.g. "WEBINARS & EVENTS") ends the section.
const SECTION_END = /^\s*#*\s*[A-Z][A-Z &/,-]{3,}\s*$/;
const URL_RE = /https?:\/\/[^\s<>)\]]+/;

/** Spec §7.1: subject prefix AND required body marker. Sender allowlist is the caller's job. */
export function isFundingForwardEmail(email: Pick<RawEmail, "subject" | "body">): boolean {
  return /^\s*funding forward:/i.test(email.subject) && email.body.split(/\r?\n/).some((l) => SECTION_START.test(l));
}

export function extractOpportunitySection(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => SECTION_START.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line) && !SECTION_START.test(line)) break;
    out.push(line);
  }
  return out;
}

export function splitBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (cur.length) blocks.push(cur.join("\n"));
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

function labelled(block: string, label: RegExp): string | undefined {
  const m = block.match(new RegExp(`^\\s*(?:${label.source})\\s*[:\\-–]\\s*(.+)$`, "im"));
  return m?.[1]?.trim();
}

/** Deterministic extraction of one opportunity block. Never throws; low confidence + warnings instead. */
export function parseBlock(block: string, email: RawEmail): GrantOpportunityCandidate {
  const warnings: string[] = [];
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  let first = lines[0] ?? "";

  let geography_raw: string | undefined;
  const tag = first.match(/^[\[(]([^\])]{2,40})[\])]\s*(.*)$/) ?? first.match(/^([A-Za-z .,&-]{2,30}?)\s*[|–—]\s+(.*)$/);
  if (tag) {
    geography_raw = tag[1]!.trim();
    first = tag[2]!.trim();
  }

  const url = block.match(URL_RE)?.[0]?.replace(/[.,;]+$/, "");
  const title = first.replace(URL_RE, "").replace(/[()<>\s-]+$/g, "").replace(/^[\s-]+/, "").trim();

  const amount_raw = labelled(block, /amount|award|funding|prize/i);
  const deadline_raw = labelled(block, /deadline|due|closes?/i);
  const eligibility_summary = labelled(block, /eligibility|who can apply|eligible/i);

  const descLines = lines.slice(1).filter((l) => !/^(amount|award|funding|prize|deadline|due|closes?|eligibility|who can apply|eligible)\s*[:\-–]/i.test(l) && !(URL_RE.test(l) && l.replace(URL_RE, "").trim() === ""));
  const description = descLines.join(" ").trim();

  const ref = new Date(email.received_at);
  const amount = parseAmount(amount_raw ?? description.match(/(?:up to\s+)?\$\s?\d[\d,.]*\s?(?:k|mm|m|million)?(?:\s*[-–to]+\s*\$\s?\d[\d,.]*\s?(?:k|mm|m|million)?)?/i)?.[0]);
  const dl = parseDeadline(deadline_raw ?? description.match(/(?:deadline|due|closes?)[:\s]+([^.;]+)/i)?.[1], ref);

  let confidence = 1;
  if (!title) { confidence -= 0.5; warnings.push("missing title"); }
  if (!url) { confidence -= 0.2; warnings.push("missing opportunity URL"); }
  if (!geography_raw) { confidence -= 0.1; warnings.push("missing geography tag"); }
  if (dl.type === "unknown") { confidence -= 0.1; warnings.push("deadline not found or not understood"); }
  if (amount.min === undefined && amount.max === undefined) { confidence -= 0.05; warnings.push("amount not found"); }
  if (!/[A-Za-z]{3,}(\s+[A-Za-z]{2,}){2,}/.test(description)) { confidence -= 0.1; warnings.push("missing or unintelligible description"); }
  if (!url && dl.type === "unknown") { confidence -= 0.2; warnings.push("no URL and no deadline: not enough to identify the opportunity"); }

  const c: GrantOpportunityCandidate = {
    source_email_id: email.id,
    source_email_subject: email.subject,
    source_received_at: email.received_at,
    source_provider: "Fast Forward",
    source_block_text: block,
    title,
    geography_normalized: normalizeGeography(geography_raw),
    opportunity_type: classifyType(`${title} ${description}`),
    description,
    deadline_type: dl.type,
    extraction_confidence: Math.max(0, Math.round(confidence * 100) / 100),
    extraction_warnings: warnings,
    parser_version: PARSER_VERSION,
  };
  if (url) c.source_opportunity_url = canonicalUrl(url) ?? url;
  if (geography_raw) c.geography_raw = geography_raw;
  if (amount_raw) c.amount_raw = amount_raw;
  if (amount.min !== undefined) c.amount_min_usd = amount.min;
  if (amount.max !== undefined) c.amount_max_usd = amount.max;
  if (deadline_raw) c.deadline_raw = deadline_raw;
  if (dl.date) c.deadline_date = dl.date;
  if (eligibility_summary) c.eligibility_summary = eligibility_summary;
  return c;
}

export function parseFundingForward(email: RawEmail): GrantOpportunityCandidate[] {
  if (!isFundingForwardEmail(email)) return [];
  return splitBlocks(extractOpportunitySection(email.body)).map((b) => parseBlock(b, email));
}
