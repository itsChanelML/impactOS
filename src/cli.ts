#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluateAll, ingestEmail, recordDecision } from "./pipeline.js";
import { OrgProfileSchema } from "./profile.js";
import { Store } from "./store.js";
import { toSheetRows, SHEET_COLUMNS } from "./sheet.js";
import type { DecisionKind } from "./types.js";

const USAGE = `impactos <command> [options]

  ingest <email.txt> --subject "Funding Forward: ..." [--id msg-id] [--received ISO]
  evaluate --profile profile.json
  list [--state AUTO_ARCHIVE|REVIEW_STRONG_FIT|...]
  show <grant-id>
  decide <grant-id> <PURSUE|PASS|RESEARCH_MORE|ESCALATE> --actor you [--rationale ...] [--override-reason ...]
  export-sheet            (TSV to stdout)
  audit                   (audit log as JSON)

Global: --store <path>  (default .impactos/state.json)`;

function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      store: { type: "string", default: ".impactos/state.json" },
      subject: { type: "string" }, id: { type: "string" }, received: { type: "string" },
      profile: { type: "string" }, state: { type: "string" },
      actor: { type: "string" }, rationale: { type: "string" }, "override-reason": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) return console.log(USAGE);
  const store = new Store(resolve(values.store!));

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

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
