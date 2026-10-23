# Roadmap

Tracked as GitHub issues (label `epic`). Order is a suggestion, not a promise.

- **E1 Source ingestion** — ✅ Gmail pull (label query, read-only OAuth, sender allowlist, retry on failure). Remaining: push notifications (Pub/Sub watch) for near-real-time, other trusted newsletters.
- **E2 Parser hardening** — more real-world newsletter fixtures, HTML parsing, parser versioning.
- **E3 Normalization** — LLM-assisted extraction for ambiguous fields; official-page verification with conflict preservation.
- **E5 Sheet projection** — ✅ two-way Google Sheets sync with warning-protected system columns and a decision dropdown. Remaining: saved filter views, scheduled sync, locking.
- **E6 Org profile & evidence library** — Drive evidence index, approval status, versions.
- **E7 Qualification** — pluggable LLM evaluator, richer capacity model, review-brief generator.
- **E9 Notifications** — Slack/email digests, deadline reminders, claim/completion celebrations.
- **E10 MCP server** — read/evaluate/save-decision tools with scoped auth and audit IDs.
- **E11 Skills** — grant-intake, grant-qualification, evidence-audit, application-prep.
- **E12 Evals & observability** — gold dataset, extraction/disqualifier evals, reviewer-override metrics.
- **E13 Funder mode** — applicant schema, diligence skill; award decisions stay human.
- **Pilot kit** — onboarding guide for a second nonprofit to test transferability.
