#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluateAll, ingestEmail, recordDecision } from "./pipeline.js";
import { OrgProfileSchema } from "./profile.js";
import { Store } from "./store.js";
import { toSheetRows, SHEET_COLUMNS } from "./sheet.js";
import { GoogleSheetsClient } from "./google-sheets.js";
import { syncSheet } from "./sheets-sync.js";
import { GmailRestClient, authorizeInteractive, pullGmail } from "./gmail.js";
import type { DecisionKind } from "./types.js";

const USAGE = `impactos <command> [options]

  ingest <email.txt> --subject "Funding Forward: ..." [--id msg-id] [--received ISO]
  evaluate --profile profile.json
  list [--state AUTO_ARCHIVE|REVIEW_STRONG_FIT|...]
  show <grant-id>
  decide <grant-id> <PURSUE|PASS|RESEARCH_MORE|ESCALATE> --actor you [--rationale ...] [--override-reason ...]
  gmail auth              (one-time: get a read-only Gmail refresh token)
  gmail pull [--query "label:..."] [--from ffwd.org] [--max 50]
  run --profile profile.json [--sheet-id <id>]   (gmail pull -> evaluate -> sheet sync)
  sheet setup --sheet-id <id> [--tab Pipeline]   (headers, dropdown, protection; run once)
  sheet sync  --sheet-id <id> [--tab Pipeline]   (two-way sync with a Google Sheet)
  export-sheet            (TSV to stdout)
  audit                   (audit log as JSON)

Global: --store <path>  (default .impactos/state.json)`;

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      store: { type: "string", default: ".impactos/state.json" },
      subject: { type: "string" }, id: { type: "string" }, received: { type: "string" },
      profile: { type: "string" }, state: { type: "string" },
      query: { type: "string" }, from: { type: "string", multiple: true }, max: { type: "string" },
      "sheet-id": { type: "string" }, tab: { type: "string", default: "Pipeline" },
      actor: { type: "string" }, rationale: { type: "string" }, "override-reason": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) return console.log(USAGE);
  const store = new Store(resolve(values.store!));
  const pullOpts = () => ({
    ...(values.query ? { query: values.query } : {}),
    ...(values.from?.length ? { allowedSenders: values.from } : {}),
    ...(values.max ? { max: Number(values.max) } : {}),
  });

  switch (cmd) {
    case "ingest": {
      const file = rest[0];
      if (!file || !values.subject) throw new Error("usage: ingest <email.txt> --subject <subject>");
      const r = ingestEmail(store, {
        id: values.id ?? file, subject: values.subject, received_at: values.received ?? new Date().toISOString(),
        body: readFileSync(file, "utf8"),
      });
      return console.log(JSON.stringify(r, null, 2));
    }
    case "evaluate": {
      if (!values.profile) throw new Error("--profile is required");
      const profile = OrgProfileSchema.parse(JSON.parse(readFileSync(values.profile, "utf8")));
      for (const ev of evaluateAll(store, profile)) {
        const g = store.state.grants[ev.grant_id]!;
        console.log(`${g.id}  ${ev.workflow_state.padEnd(18)} ${g.title}`);
      }
      return;
    }
    case "list": {
      for (const g of store.grants()) {
        const ev = store.latestEvaluation(g.id);
        if (values.state && ev?.workflow_state !== values.state) continue;
        console.log(`${g.id}  ${g.status.padEnd(9)} ${(ev?.workflow_state ?? "-").padEnd(18)} ${g.deadline_date ?? g.deadline_type}  ${g.title}`);
      }
      return;
    }
    case "show": {
      const g = store.state.grants[rest[0] ?? ""];
      if (!g) throw new Error("unknown grant id");
      return console.log(JSON.stringify({ grant: g, evaluation: store.latestEvaluation(g.id) }, null, 2));
    }
    case "decide": {
      const [grantId, decision] = rest;
      if (!grantId || !decision || !values.actor) throw new Error("usage: decide <grant-id> <DECISION> --actor <you>");
      const d = recordDecision(store, {
        grantId, decision: decision as DecisionKind, actorId: values.actor,
        ...(values.rationale ? { rationale: values.rationale } : {}),
        ...(values["override-reason"] ? { overrideReason: values["override-reason"] } : {}),
      });
      return console.log(JSON.stringify(d, null, 2));
    }
    case "gmail": {
      if (rest[0] === "auth") {
        const id = process.env.GMAIL_CLIENT_ID, secret = process.env.GMAIL_CLIENT_SECRET;
        if (!id || !secret) throw new Error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (Desktop OAuth client) first. See docs/gmail.md.");
        const token = await authorizeInteractive(id, secret);
        return console.log(`\nAdd this to your environment (treat it like a password):\n\nGMAIL_REFRESH_TOKEN=${token}`);
      }
      if (rest[0] === "pull") return console.log(JSON.stringify(await pullGmail(store, new GmailRestClient(), pullOpts()), null, 2));
      throw new Error("usage: gmail <auth|pull>");
    }
    case "run": {
      if (!values.profile) throw new Error("--profile is required");
      const profile = OrgProfileSchema.parse(JSON.parse(readFileSync(values.profile, "utf8")));
      const pulled = await pullGmail(store, new GmailRestClient(), pullOpts());
      const evals = evaluateAll(store, profile);
      console.log(`Gmail: ${pulled.listed} listed, ${pulled.ingested.length} ingested, ${pulled.alreadyProcessed} already processed, ${pulled.failed.length} failed, ${pulled.rejectedSender.length} rejected sender`);
      console.log(`Evaluated ${evals.length} new opportunities`);
      const sheetId = values["sheet-id"] ?? process.env.IMPACTOS_SHEET_ID;
      if (sheetId) {
        const r = await syncSheet(store, new GoogleSheetsClient({ spreadsheetId: sheetId }), values.tab!);
        console.log(`Sheet: ${r.appended} added, ${r.cellsWritten} cells written, ${r.decisionsApplied} decisions applied, ${r.rejected.length} rejected`);
      }
      if (pulled.failed.length) process.exitCode = 2;
      return;
    }
    case "sheet": {
      const sheetId = values["sheet-id"] ?? process.env.IMPACTOS_SHEET_ID;
      if (!sheetId) throw new Error("--sheet-id (or IMPACTOS_SHEET_ID) is required");
      const client = new GoogleSheetsClient({ spreadsheetId: sheetId });
      const tab = values.tab!;
      if (rest[0] === "setup") {
        await client.setup(tab);
        return console.log(`Prepared tab "${tab}".`);
      }
      if (rest[0] === "sync") {
        const r = await syncSheet(store, client, tab);
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      throw new Error("usage: sheet <setup|sync> --sheet-id <id>");
    }
    case "export-sheet":
      console.log(SHEET_COLUMNS.join("\t"));
      for (const row of toSheetRows(store)) console.log(row.map((c) => c.replace(/[\t\n]/g, " ")).join("\t"));
      return;
    case "audit":
      return console.log(JSON.stringify(store.state.audit, null, 2));
    default:
      throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
