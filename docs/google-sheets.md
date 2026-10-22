# Google Sheets sync

The Sheet is where your team works; the ImpactOS store is the source of truth. `impactos sheet sync` keeps them aligned in both directions.

## One-time setup

1. In Google Cloud, create a project, enable the **Google Sheets API**, and create a **service account**. Download its JSON key.
2. Create a spreadsheet and **share it with the service account's email as Editor**.
3. Point ImpactOS at the key and the sheet (the ID is the long string in the sheet URL):

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json   # keep this file out of git
export IMPACTOS_SHEET_ID=<spreadsheet id>

npx impactos sheet setup            # creates the "Pipeline" tab, headers, decision dropdown, column warnings
npx impactos sheet sync             # run any time, or on a schedule
```

Use `--tab <name>` for a different tab name and `--sheet-id` instead of the env var if you prefer.

## What each side owns

| Columns | Owner | Behavior |
|---|---|---|
| Record ID, Title, Funder, State/Country, Type, Description, Amount, Deadline, Website, Date Posted, Status, AI Workflow State, Hard Eligibility, all fit/effort scores, Missing Info, AI Rationale, AI Confidence, Source Email IDs, Version, Last Updated, Sync Status | ImpactOS | Overwritten on every sync. Edits show a warning (protection is warning-only so nobody gets locked out). |
| Owner, Human Decision, Decision By, Decision Rationale, Override Reason | Your team | Read back on sync. Never overwritten while you have an edit pending. |

Columns are matched by **header name**, so you can reorder them, hide them, or add your own columns (e.g. "Team Notes"); ImpactOS leaves unknown columns alone. Rows are matched by **Record ID**; don't edit that column.

## Recording a decision in the Sheet

Pick a value in **Human Decision** (`PURSUE`, `PASS`, `RESEARCH_MORE`, `ESCALATE`) and fill in **Decision By**. On the next sync it goes through exactly the same rules as the CLI:

- A decision needs a named person.
- If it disagrees with the AI recommendation (for example, PASS on a strong fit), **Override Reason** is required.
- Illegal status changes are rejected.

Anything rejected is explained in the row's **Sync Status** cell and your typed value stays put so you can fix it. Accepted decisions are written to the audit log with your name.

Decisions recorded elsewhere (CLI, future UI) are filled into the Sheet on the next sync, unless you have an unsynced edit in that cell.

## Safety notes

- Values are written as **literal text** (`valueInputOption: RAW`), so text from a newsletter such as `=IMPORTDATA(...)` can never run as a formula.
- The service account can only reach spreadsheets explicitly shared with it.
- Concurrent syncs are not locked. Run one at a time (a single scheduled job is ideal).
- The Sheet contains your pipeline data. Share it only with your team.
