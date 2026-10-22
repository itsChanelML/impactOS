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

const DEADLINES_START = /^\s*#*\s*upcoming\s+deadlines\s*$/i;

function extractSection(body: string, startRe: RegExp): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => startRe.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line)) break;
    out.push(line);
  }
  return out;
}

export const extractOpportunitySection = (body: string) => extractSection(body, SECTION_START);
export const extractDeadlineSection = (body: string) => extractSection(body, DEADLINES_START);

// Newsletter links are HubSpot click-tracking redirects: unique per email and per recipient,
// so they are kept for humans but are NOT usable as a canonical URL for dedupe.
const TRACKING_HOST = /hubspotlinks\.com|hubspotemail\.net|list-manage\.com|mailchi\.mp|sendgrid\.net|click\./i;
export function isTrackingUrl(url: string): boolean {
  try { return TRACKING_HOST.test(new URL(url).hostname); } catch { return false; }
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
  const dlText = deadline_raw ?? description.match(/(?:deadline|due|closes?|apply by|(?:proposal|application) by)[:\s]+([^.;]+)/i)?.[1] ?? description.match(/\b(rolling basis)\b/i)?.[1];
  const dl = parseDeadline(dlText, ref);

  let confidence = 1;
  if (!title) { confidence -= 0.5; warnings.push("missing title"); }
  if (!url) { confidence -= 0.2; warnings.push("missing opportunity URL"); }
  else if (isTrackingUrl(url)) warnings.push("tracking link only; official URL not yet resolved");
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
  if (url && isTrackingUrl(url)) c.source_tracking_url = url;
  else if (url) c.source_opportunity_url = canonicalUrl(url) ?? url;
  if (geography_raw) c.geography_raw = geography_raw;
  if (amount_raw) c.amount_raw = amount_raw;
  if (amount.min !== undefined) c.amount_min_usd = amount.min;
  if (amount.max !== undefined) c.amount_max_usd = amount.max;
  if (dlText) c.deadline_raw = dlText.trim();
  if (dl.date) c.deadline_date = dl.date;
  if (eligibility_summary) c.eligibility_summary = eligibility_summary;
  return c;
}

const BULLET = /^\s*-\s*\[([^\]]{2,60})\]\s+(.+)$/;
const DEADLINE_ITEM = /^\s*(?:-\s*)?Apply by\s+(.+?)\s+-\s+\[([^\]]{2,60})\]\s+(.+)$/i;

const keyOf = (funder: string | undefined, title: string) => `${funder ?? ""}|${title}`.toLowerCase().replace(/[^a-z0-9|]+/g, " ").trim();

/** "Funder: Program (link) : narrative..." -> parts. Narrative is whatever follows the link. */
function splitFunder(rest: string): { url?: string; funder?: string; title: string; narrative: string } {
  const m = rest.match(URL_RE);
  const url = m?.[0]?.replace(/[.,;]+$/, "");
  const before = (m ? rest.slice(0, m.index) : rest).replace(/[\s(<]+$/, "").trim();
  const narrative = m ? rest.slice((m.index ?? 0) + m[0].length).replace(/^[\s)>\]:–-]+/, "").trim() : "";
  const idx = before.indexOf(": ");
  return { ...(url ? { url } : {}), ...(idx > 0 && idx < 80 ? { funder: before.slice(0, idx).trim() } : {}), title: before, narrative };
}

/** Real Funding Forward shape: "- [Geo] Funder: Program (link)" plus a separate "UPCOMING DEADLINES" list. */
function parseBulletFormat(email: RawEmail): GrantOpportunityCandidate[] {
  const funding = extractOpportunitySection(email.body);
  const deadlines = extractDeadlineSection(email.body);
  const byKey = new Map<string, GrantOpportunityCandidate>();
  const out: GrantOpportunityCandidate[] = [];

  const build = (line: string, geo: string, rest: string, deadlineRaw?: string) => {
    const { url, funder, title, narrative } = splitFunder(rest);
    const synthetic = [`[${geo}] ${title}${url ? ` (${url})` : ""}`, narrative, deadlineRaw ? `Deadline: ${deadlineRaw}` : ""].filter(Boolean).join("\n");
    const c = parseBlock(synthetic, email);
    c.source_block_text = line.trim();
    if (funder) c.funder_name = funder;
    if (url && isTrackingUrl(url)) c.source_tracking_url = url;
    return c;
  };

  for (const line of funding) {
    const m = line.match(BULLET);
    if (!m) continue;
    const c = build(line, m[1]!, m[2]!);
    byKey.set(keyOf(c.funder_name, c.title), c);
    out.push(c);
  }
  for (const line of deadlines) {
    const m = line.match(DEADLINE_ITEM);
    if (!m) continue;
    const { funder, title } = splitFunder(m[3]!);
    const hit = byKey.get(keyOf(funder, title));
    if (hit) {
      // merge the deadline into the matching funding-list entry, keeping provenance of both lines
      const dl = parseDeadline(m[1]!, new Date(email.received_at));
      hit.deadline_raw = m[1]!;
      hit.deadline_type = dl.type;
      if (dl.date) hit.deadline_date = dl.date;
      hit.source_block_text += `\n${line.trim()}`;
      hit.extraction_warnings = hit.extraction_warnings.filter((w) => !/deadline/.test(w));
      hit.extraction_confidence = Math.min(1, Math.round((hit.extraction_confidence + 0.1) * 100) / 100);
    } else {
      const c = build(line, m[2]!, m[3]!, m[1]!);
      byKey.set(keyOf(c.funder_name, c.title), c);
      out.push(c);
    }
  }
  return out;
}

export function parseFundingForward(email: RawEmail): GrantOpportunityCandidate[] {
  if (!isFundingForwardEmail(email)) return [];
  const section = extractOpportunitySection(email.body);
  if (section.some((l) => BULLET.test(l))) return parseBulletFormat(email);
  return splitBlocks(section).map((b) => parseBlock(b, email));
}
