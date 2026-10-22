# Architecture

ImpactOS separates **canonical records** from **surfaces**. Records live in a `Store`; Sheets, Slack, a CLI, or an MCP server are views/controllers over it.

| Module | Responsibility |
|---|---|
| `parser.ts` | Detect a funding email (subject prefix **and** body marker), extract the opportunities section, split blocks, deterministic field extraction with confidence + warnings. |
| `normalize.ts` | Dates → ISO (raw preserved), amounts → min/max USD, geography tokens, opportunity type, canonical URLs. |
| `dedupe.ts` | Priority order: canonical URL → title+funder → title+deadline(+amount). No automatic fuzzy/model merge below threshold. |
| `pipeline.ts` | `ingestEmail` (idempotent, quarantines low-confidence blocks, versions updates), `evaluateGrant`, `recordDecision` (the human gate). |
| `qualify.ts` | Deterministic hard eligibility; scored dimensions; capacity; workflow state. |
| `state.ts` | Status transition graph; override detection. |
| `store.ts` | Records, evaluations, decisions, quarantine, append-only audit log. JSON-file persistence; swap for Firestore/Postgres. |
| `sheet.ts` | Sheet projection (columns + rows). |
| `cli.ts` | Thin CLI over the above. |

## Data model

`GrantOpportunity` (canonical, versioned) → latest `GrantEvaluation` → latest `HumanDecision`. Every write emits an `AuditEvent`. Quarantined parser output is stored, never dropped.

## Workflow states

`AUTO_ARCHIVE` · `REVIEW_STRONG_FIT` · `REVIEW_LOW_FIT` · `REQUEST_RESEARCH` · `ESCALATE`. Status graph: `new → research|review|archived → pursue|pass → applied → awarded|declined|withdrawn`.

## Extension points

- **Sources:** produce a `RawEmail` (or implement another parser returning `GrantOpportunityCandidate[]`).
- **Evaluators:** return an object matching `GrantEvaluation`. LLM evaluators must cite `EvidenceRef`s and must not invent organization facts.
- **Stores:** implement the `Store` surface over a database.
- **Surfaces:** anything that calls `ingestEmail` / `evaluateGrant` / `recordDecision`. Authorization belongs in the surface/server, never in model instructions.

## Target production shape

Gmail label → Gmail API watch → Pub/Sub → ingestion service → normalizer → Store (Firestore) → Sheet projection → notifications → MCP server exposing read/evaluate/save-decision tools. The data contracts above are identical for an Apps Script MVP and for the production path.
