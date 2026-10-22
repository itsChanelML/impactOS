# Decision policy

| Action | AI allowed? | Human required? |
|---|---|---|
| Parse email into records | Yes | Only when confidence is low (quarantine queue) |
| Normalize dates/amounts/geography | Yes | Exceptions only |
| Identify an explicit hard disqualifier | Yes | Audit available; auto-archive only when deterministic and ≥ 0.95 confidence |
| Assess alignment, estimate effort | Yes | Humans may override |
| Recommend a workflow state | Yes | **Yes**, for the final pursue/pass decision |
| Submit an application | **No** (v1) | Yes |
| Make an award decision (funder mode) | **No** | Yes |
| Change authoritative organization facts | **No** | Yes, via approved source update |

## Rules the code enforces

1. Unknown or ambiguous eligibility is never auto-archived.
2. Decisions need a named actor; overriding the AI recommendation needs a reason.
3. Illegal status transitions are rejected.
4. Nothing is silently dropped: low-confidence parses are quarantined, low fits stay human-visible.
5. Source conflicts are preserved, not overwritten, and route to `ESCALATE`.

## Evidence taxonomy

`SOURCE_FACT` (in the email/official page) · `ORGANIZATION_FACT` (approved org record) · `CLAIM` (unverified external statement) · `MODEL_INFERENCE` (derived; never shown as fact) · `MISSING` · `CONFLICT`.

Generated application content must not introduce unsupported organization facts; unresolved facts surface as questions.
