import { createServer } from "node:http";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { PARSER_VERSION } from "./parser.js";
import { ingestEmail, type IngestResult } from "./pipeline.js";
import type { Store } from "./store.js";
import type { RawEmail } from "./types.js";

/** Read-only: ImpactOS can list and read mail but cannot send, delete, or relabel anything. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailClient {
  /** Message IDs matching a Gmail search query, newest first. */
  listMessageIds(query: string, max: number): Promise<string[]>;
  getEmail(id: string): Promise<RawEmail & { from: string }>;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function findPart(p: Part, mime: string): string | undefined {
  if (p.mimeType === mime && p.body?.data) return b64url(p.body.data);
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return undefined;
}

/** Crude HTML -> text fallback for emails with no text/plain part. Links are kept as "text (url)". */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/(p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

export type TokenProvider = () => Promise<string>;

/** OAuth refresh token (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN) if set, else Application Default Credentials. */
export function defaultTokenProvider(env = process.env): TokenProvider {
  if (env.GMAIL_REFRESH_TOKEN) {
    if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are required with GMAIL_REFRESH_TOKEN");
    const oauth = new OAuth2Client(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET);
    oauth.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
    return async () => {
      const t = (await oauth.getAccessToken()).token;
      if (!t) throw new Error("Could not refresh the Gmail access token. Re-run `impactos gmail auth`.");
      return t;
    };
  }
  const auth = new GoogleAuth({ scopes: [GMAIL_SCOPE] });
  return async () => {
    const t = await auth.getAccessToken();
    if (!t) throw new Error("No Gmail credentials. See docs/gmail.md.");
    return t;
  };
}

export class GmailRestClient implements GmailClient {
  constructor(private readonly getToken: TokenProvider = defaultTokenProvider(), private readonly fetchImpl: typeof fetch = fetch) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${await this.getToken()}` } });
    if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async listMessageIds(query: string, max: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken = "";
    while (ids.length < max) {
      const r = await this.get<{ messages?: { id: string }[]; nextPageToken?: string }>(
        `/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(100, max - ids.length)}${pageToken ? `&pageToken=${pageToken}` : ""}`,
      );
      ids.push(...(r.messages ?? []).map((m) => m.id));
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    return ids.slice(0, max);
  }

  async getEmail(id: string): Promise<RawEmail & { from: string }> {
    const m = await this.get<{ id: string; internalDate?: string; payload: Part }>(`/messages/${id}?format=full`);
    const header = (n: string) => m.payload.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const text = findPart(m.payload, "text/plain") ?? htmlToText(findPart(m.payload, "text/html") ?? "");
    return {
      id: m.id,
      subject: header("subject"),
      from: header("from"),
      received_at: new Date(m.internalDate ? Number(m.internalDate) : Date.parse(header("date"))).toISOString(),
      body: text,
    };
  }
}

export interface PullOptions {
  /** Gmail search. Default: the canonical ingestion label. Narrow with a label so unrelated mail is never read. */
  query?: string;
  /** Sender allowlist (substring match on the From header). A subject alone is not trusted (spec §7.1). */
  allowedSenders?: string[];
  max?: number;
  now?: Date;
}

export interface PullResult {
  listed: number;
  alreadyProcessed: number;
  rejectedSender: { id: string; from: string }[];
  ingested: { id: string; subject: string; result: IngestResult }[];
  failed: { id: string; error: string }[];
}

export const DEFAULT_QUERY = "label:ImpactOS-Funding-Source newer_than:30d";
export const DEFAULT_SENDERS = ["ffwd.org"];

/**
 * Pull -> ingest. Safe to run repeatedly or on a schedule:
 * messages already processed (same parser version) are skipped without being fetched, and a message that
 * fails is recorded in the audit log and retried next run instead of being silently lost.
 */
export async function pullGmail(store: Store, client: GmailClient, opts: PullOptions = {}): Promise<PullResult> {
  const now = opts.now ?? new Date();
  const senders = (opts.allowedSenders ?? DEFAULT_SENDERS).map((s) => s.toLowerCase());
  const ids = await client.listMessageIds(opts.query ?? DEFAULT_QUERY, opts.max ?? 50);
  const out: PullResult = { listed: ids.length, alreadyProcessed: 0, rejectedSender: [], ingested: [], failed: [] };

  for (const id of ids) {
    if (store.state.processed[`${id}@${PARSER_VERSION}`]) { out.alreadyProcessed++; continue; }
    try {
      const email = await client.getEmail(id);
      if (!senders.some((s) => email.from.toLowerCase().includes(s))) {
        out.rejectedSender.push({ id, from: email.from });
        store.log({ at: now.toISOString(), kind: "parse.failed", actor: "gmail-pull", detail: { email_id: id, reason: "sender not on allowlist", from: email.from } });
        continue;
      }
      const result = ingestEmail(store, email, now);
      // Mail that is not a newsletter will never become one: remember it so it is not refetched every run.
      if (result.skipped === "not_funding_forward") store.state.processed[`${id}@${PARSER_VERSION}`] = true;
      out.ingested.push({ id, subject: email.subject, result });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.failed.push({ id, error });
      store.log({ at: now.toISOString(), kind: "parse.failed", actor: "gmail-pull", detail: { email_id: id, error } });
    }
  }
  store.save();
  return out;
}

/**
 * One-time OAuth consent on your own machine: opens a loopback listener, prints a URL, and prints the
 * refresh token to store in GMAIL_REFRESH_TOKEN. Requires a Google Cloud "Desktop app" OAuth client.
 */
export async function authorizeInteractive(clientId: string, clientSecret: string, log: (s: string) => void = console.log): Promise<string> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const oauth = new OAuth2Client(clientId, clientSecret, `http://127.0.0.1:${port}`);
  log(`Open this URL and approve read-only Gmail access:\n\n${oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [GMAIL_SCOPE] })}\n`);
  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const c = u.searchParams.get("code");
      res.end(c ? "ImpactOS is authorized. You can close this tab." : "No code received.");
      c ? resolve(c) : reject(new Error(u.searchParams.get("error") ?? "authorization failed"));
    });
  });
  server.close();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) throw new Error("Google returned no refresh token. Revoke the app at myaccount.google.com/permissions and retry.");
  return tokens.refresh_token;
}
