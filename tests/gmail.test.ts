import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GmailRestClient, htmlToText, pullGmail, type GmailClient } from "../src/gmail.js";
import { Store } from "../src/store.js";

const fixture = readFileSync(new URL("./fixtures/funding-forward-real-shape.txt", import.meta.url), "utf8");
const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const SUBJECT = "Funding Forward: 10/12 - 10/16";
const now = new Date("2026-10-20T12:00:00Z");

function gmailMessage(id: string, opts: { from?: string; subject?: string; plain?: string; html?: string } = {}) {
  const parts: object[] = [];
  if (opts.html) parts.push({ mimeType: "text/html", body: { data: enc(opts.html) } });
  if (opts.plain !== undefined) parts.push({ mimeType: "text/plain", body: { data: enc(opts.plain) } });
  return {
    id, internalDate: String(Date.parse("2026-10-17T10:57:12Z")),
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: opts.subject ?? SUBJECT }, { name: "From", value: opts.from ?? "Fast Forward <hello@ffwd.org>" }],
      parts: [{ mimeType: "multipart/alternative", parts }], // nested, like real mail
    },
  };
}

describe("GmailRestClient", () => {
  it("lists across pages and parses nested multipart messages", async () => {
    const urls: string[] = [];
    const client = new GmailRestClient(async () => "tok", (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      if (url.includes("/messages?")) {
        return Response.json(url.includes("pageToken=p2") ? { messages: [{ id: "b" }] } : { messages: [{ id: "a" }], nextPageToken: "p2" });
      }
      return Response.json(gmailMessage("a", { plain: fixture }));
    }) as unknown as typeof fetch);

    expect(await client.listMessageIds("label:x", 10)).toEqual(["a", "b"]);
    const email = await client.getEmail("a");
    expect(email).toMatchObject({ id: "a", subject: SUBJECT, from: "Fast Forward <hello@ffwd.org>", received_at: "2026-10-17T10:57:12.000Z" });
    expect(email.body).toContain("FUNDING & OPPORTUNITIES");
    expect(urls.some((u) => u.includes("format=full"))).toBe(true);
    expect(urls[0]).toContain(encodeURIComponent("label:x"));
  });

  it("falls back to HTML-to-text when there is no text/plain part", async () => {
    const client = new GmailRestClient(async () => "t", (async () =>
      Response.json(gmailMessage("h", { html: "<p>FUNDING &amp; OPPORTUNITIES</p><p>- [US] Fund: Grant <a href=\"https://x.org/a\">link</a></p>" }))) as unknown as typeof fetch);
    const email = await client.getEmail("h");
    expect(email.body).toContain("FUNDING & OPPORTUNITIES");
    expect(email.body).toContain("link (https://x.org/a)");
  });

  it("surfaces API errors", async () => {
    const client = new GmailRestClient(async () => "t", (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);
    await expect(client.listMessageIds("q", 5)).rejects.toThrow(/Gmail API 401/);
  });

  it("htmlToText strips scripts and tags", () => {
    expect(htmlToText("<style>x{}</style><div>Hi<br>there</div>")).toBe("Hi\nthere\n");
  });
});

class FakeGmail implements GmailClient {
  fetched: string[] = [];
  constructor(private readonly msgs: Record<string, { from: string; subject: string; body: string } | Error>) {}
  async listMessageIds() { return Object.keys(this.msgs); }
  async getEmail(id: string) {
    this.fetched.push(id);
    const m = this.msgs[id]!;
    if (m instanceof Error) throw m;
    return { id, received_at: "2026-10-17T10:57:12.000Z", ...m };
  }
}

describe("pullGmail", () => {
  const good = { from: "Fast Forward <hello@ffwd.org>", subject: SUBJECT, body: fixture };

  it("ingests newsletters and skips already-processed messages without refetching", async () => {
    const store = new Store();
    const gmail = new FakeGmail({ m1: good });
    const r1 = await pullGmail(store, gmail, { now });
    expect(r1.ingested).toHaveLength(1);
    expect(r1.ingested[0]!.result.created).toHaveLength(4);
    const r2 = await pullGmail(store, gmail, { now });
    expect(r2.alreadyProcessed).toBe(1);
    expect(gmail.fetched).toEqual(["m1"]); // second run made no fetch
    expect(store.grants()).toHaveLength(4);
  });

  it("rejects senders not on the allowlist, even when the subject matches", async () => {
    const store = new Store();
    const r = await pullGmail(store, new FakeGmail({ spoof: { ...good, from: "Attacker <x@evil.example>" } }), { now });
    expect(r.rejectedSender).toEqual([{ id: "spoof", from: "Attacker <x@evil.example>" }]);
    expect(store.grants()).toHaveLength(0);
  });

  it("one failing message is logged and does not stop the rest", async () => {
    const store = new Store();
    const r = await pullGmail(store, new FakeGmail({ bad: new Error("boom"), m1: good }), { now });
    expect(r.failed).toEqual([{ id: "bad", error: "boom" }]);
    expect(r.ingested).toHaveLength(1);
    expect(store.state.audit.some((e) => e.kind === "parse.failed" && e.detail.email_id === "bad")).toBe(true);
    // a failed message is retried next run, not marked processed
    const again = await pullGmail(store, new FakeGmail({ bad: good }), { now });
    expect(again.ingested).toHaveLength(1);
  });

  it("ignores non-newsletter mail from an allowed sender", async () => {
    const store = new Store();
    const r = await pullGmail(store, new FakeGmail({ x: { ...good, subject: "Webinar invite", body: "hello" } }), { now });
    expect(r.ingested[0]!.result.skipped).toBe("not_funding_forward");
    expect(store.grants()).toHaveLength(0);
    expect((await pullGmail(store, new FakeGmail({ x: good }), { now })).alreadyProcessed).toBe(1);
  });
});
