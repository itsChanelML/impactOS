# ImpactOS

**Open-source, AI-native philanthropy operations.** ImpactOS turns the weekly flood of funding newsletters into a structured, deduplicated, evidence-backed grant pipeline — and keeps a human in charge of every consequential decision.

> Status: **v0.1 (alpha)**. The deterministic core (parse → normalize → dedupe → qualify → human decision → audit) works and is tested. Gmail/Sheets/Drive adapters, LLM-assisted steps, and the MCP/plugin layer are on the [roadmap](ROADMAP.md).

## Why

Volunteer-run nonprofits lose institutional knowledge every time a volunteer rotates off, and grant discovery is mostly copy/paste. ImpactOS was born at [Mentor Me Collective](https://www.mentormecollective.org) (the first design partner) to make grant work accessible to people with no prior grant-writing experience, and to make it survive turnover.

Two principles drive the design:

1. **Qualify before drafting.** Decide whether an opportunity deserves effort *before* anyone writes a word.
2. **AI recommends; humans decide.** The system never submits, never makes award decisions, and never silently discards an opportunity it is unsure about.

## What it does today

```
Funding email ─▶ parse blocks ─▶ normalize (dates, $, geo, type, URL) ─▶ dedupe/version
                                                         │
          parser-review queue ◀── low confidence ────────┘
                                                         ▼
                      qualify: hard eligibility + scored dimensions + capacity
                                                         ▼
     AUTO_ARCHIVE │ REVIEW_STRONG_FIT │ REVIEW_LOW_FIT │ REQUEST_RESEARCH │ ESCALATE
                                                         ▼
                 human decision: PURSUE / PASS / RESEARCH_MORE / ESCALATE
                          (overrides of the AI require a reason)
                                                         ▼
                                   append-only audit log
```

- **Traceable:** every record keeps its source email ID, raw block text, and raw values next to normalized ones.
- **Idempotent:** re-ingesting an email is a no-op; a repeated opportunity with a new deadline/amount becomes a new *version* with a field-level change log.
- **Conservative:** `AUTO_ARCHIVE` requires a deterministic rule hit at ≥0.95 confidence. Unknown eligibility → `REQUEST_RESEARCH`, never archive.
- **Explainable:** no single opaque score. Each evaluation exposes component dimensions, rationale, missing information, and confidence (which is *not* a probability of winning).
- **Familiar:** a Google-Sheet-shaped projection (`export-sheet`) so teams keep their existing workflow.

## Quick start

Requires Node ≥ 20.

```bash
git clone https://github.com/itsChanelML/impactOS.git && cd impactOS
npm install && npm test && npm run build

# 1. Ingest a "Funding Forward"-style email (see tests/fixtures for the expected shape)
npx impactos ingest tests/fixtures/funding-forward-1.txt \
  --subject "Funding Forward: 10/19 - 10/23" --id msg-1 --received 2026-10-19T12:00:00Z

# 2. Qualify against your organization profile (edit examples/profile.json)
npx impactos evaluate --profile examples/profile.json
npx impactos list

# 3. Record a human decision
npx impactos decide grant_00001 PURSUE --actor sam --rationale "Fits fall programming"

# 4. Export a Sheet-ready TSV, or read the audit trail
npx impactos export-sheet > pipeline.tsv
npx impactos audit
```

State is stored in `.impactos/state.json` (override with `--store`).

### As a library

```ts
import { Store, ingestEmail, evaluateAll, recordDecision, OrgProfileSchema } from "impactos";
const store = new Store(".impactos/state.json");
ingestEmail(store, { id, subject, received_at, body });
evaluateAll(store, OrgProfileSchema.parse(profileJson));
recordDecision(store, { grantId, actorId: "sam", decision: "PURSUE" });
```

## Configure it for your organization

Copy `examples/profile.json` and set your geographies, mission/population/program keywords, evidence keywords, minimum award size, extra hard disqualifiers (regex + reason), and sensitive terms that must always go to a senior reviewer. Capacity thresholds are in `CapacityConfigSchema` (`src/profile.ts`).

## Documentation

- [Architecture](docs/architecture.md) — components, data model, extension points
- [Decision policy](docs/decision-policy.md) — what AI may and may not do; evidence taxonomy
- [Roadmap](ROADMAP.md) — Gmail/Sheets adapters, LLM extraction, MCP server, funder mode
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## Limitations (please read)

- The email parser targets a documented plain-text shape; real newsletters vary. Contributions of anonymized fixtures and parser improvements are the most valuable thing you can send.
- The v0.1 evaluator is rules/keyword based. It is a transparent baseline, not a substitute for judgment. LLM-assisted evaluators plug in behind the same `GrantEvaluation` shape.
- Evaluation scores are decision support. They do not certify accuracy and are not predictions of award.

## License

Apache-2.0. See [LICENSE](LICENSE).
