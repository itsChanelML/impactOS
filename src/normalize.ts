import type { DeadlineType, OpportunityType } from "./types.js";

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

const pad = (n: number) => String(n).padStart(2, "0");

function validIso(y: number, m: number, d: number): string | undefined {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** If the year is missing, pick the next occurrence on/after `ref`. */
function inferYear(m: number, d: number, ref: Date): number {
  const y = ref.getUTCFullYear();
  const thisYear = Date.UTC(y, m - 1, d);
  const refDay = Date.UTC(y, ref.getUTCMonth(), ref.getUTCDate());
  return thisYear >= refDay ? y : y + 1;
}

export interface ParsedDeadline {
  type: DeadlineType;
  date?: string;
}

/** Raw deadline string -> ISO date + semantics. Raw string is kept by the caller. */
export function parseDeadline(raw: string | undefined, ref: Date): ParsedDeadline {
  if (!raw) return { type: "unknown" };
  const s = raw.trim().toLowerCase();
  if (/\brolling\b|\bongoing\b|\bopen until filled\b/.test(s)) return { type: "rolling" };
  if (/\bmonthly\b|\bevery month\b/.test(s)) return { type: "monthly" };

  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const iso = validIso(+m[1]!, +m[2]!, +m[3]!);
    return iso ? { type: "fixed", date: iso } : { type: "unknown" };
  }
  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const mo = +m[1]!, d = +m[2]!;
    let y = m[3] ? +m[3] : inferYear(mo, d, ref);
    if (y < 100) y += 2000;
    const iso = validIso(y, mo, d);
    return iso ? { type: "fixed", date: iso } : { type: "unknown" };
  }
  m = s.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3)) + 1;
    if (mo > 0) {
      const d = +m[2]!;
      const y = m[3] ? +m[3] : inferYear(mo, d, ref);
      const iso = validIso(y, mo, d);
      if (iso) return { type: "fixed", date: iso };
    }
  }
  return { type: "unknown" };
}

export interface ParsedAmount {
  min?: number;
  max?: number;
}

function money(num: string, suffix?: string): number {
  let v = parseFloat(num.replace(/,/g, ""));
  const x = suffix?.toLowerCase();
  if (x === "k") v *= 1e3;
  else if (x === "m" || x === "mm" || x === "million") v *= 1e6;
  else if (x === "b" || x === "billion") v *= 1e9;
  return Math.round(v);
}

/** Parses "$5K", "up to $50,000", "$10,000 - $50,000". USD only; other currencies stay raw. */
export function parseAmount(raw: string | undefined): ParsedAmount {
  if (!raw) return {};
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|b|million|billion)?\b/gi;
  const vals: number[] = [];
  for (const m of raw.matchAll(re)) vals.push(money(m[1]!, m[2]));
  if (vals.length === 0) return {};
  if (vals.length === 1) {
    return /\bup to\b|\bmax(imum)?\b/i.test(raw) ? { max: vals[0] } : { min: vals[0], max: vals[0] };
  }
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

/**
 * Normalizes a geography tag into tokens: "GLOBAL", "US", "US-<ST>", or a country name.
 * Unrecognized text is kept as-is (title-cased) so nothing is silently dropped.
 */
export function normalizeGeography(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(/[,/;&]|\band\b/i).map((p) => p.trim()).filter(Boolean)) {
    const up = part.toUpperCase().replace(/\./g, "");
    if (/^(GLOBAL|WORLDWIDE|INTERNATIONAL)$/.test(up)) out.add("GLOBAL");
    else if (/^(US|USA|UNITED STATES|NATIONAL)$/.test(up)) out.add("US");
    else if (US_STATES[up]) out.add(`US-${up}`);
    else {
      const st = Object.entries(US_STATES).find(([, n]) => n.toUpperCase() === up);
      out.add(st ? `US-${st[0]}` : part);
    }
  }
  return [...out];
}

export function classifyType(text: string): OpportunityType {
  const s = text.toLowerCase();
  if (/\bfellowship\b/.test(s)) return "fellowship";
  if (/\baccelerator\b|\bincubator\b/.test(s)) return "accelerator";
  if (/\bpitch\b|\bcompetition\b|\bchallenge\b|\bprize\b/.test(s)) return "pitch_competition";
  if (/\bin-kind\b|\bpro bono\b|\bdonated\b/.test(s)) return "in_kind";
  if (/\bcredits?\b/.test(s)) return "credit";
  if (/\bgrants?\b|\bfunding\b|\bfund\b/.test(s)) return "grant";
  if (/\bresource\b|\btoolkit\b|\bguide\b/.test(s)) return "resource";
  return "other";
}

const TRACKING = /^(utm_|mc_|fbclid|gclid|ref$|ref_src|source$)/i;

/** Canonical form for dedupe: lowercase host, no www, no tracking params/fragment/trailing slash. */
export function canonicalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return undefined;
  }
}
