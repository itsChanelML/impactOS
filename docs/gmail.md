# Gmail ingestion

ImpactOS reads your Funding Forward emails directly, so nobody copies and pastes. It uses **read-only** Gmail access (`gmail.readonly`): it can list and read mail, but cannot send, delete, or relabel anything.

## 1. Label the newsletters

In Gmail, create a filter: from `hello@ffwd.org` (or your newsletter's sender) and subject `Funding Forward:` → **Apply label** `ImpactOS/Funding-Source`. ImpactOS only looks at mail with that label (search syntax `label:ImpactOS-Funding-Source`), so unrelated mail is never read. Apply the label by hand to older issues you want to backfill.

## 2. Get credentials (once)

1. In Google Cloud, enable the **Gmail API** and create an **OAuth client ID** of type **Desktop app**. On the consent screen, add yourself as a test user (or publish internally if you use Google Workspace).
2. Authorize on your own machine:

```bash
export GMAIL_CLIENT_ID=...
export GMAIL_CLIENT_SECRET=...
npx impactos gmail auth        # opens a URL; approve read-only access; prints GMAIL_REFRESH_TOKEN
export GMAIL_REFRESH_TOKEN=... # treat it like a password; never commit it
```

Anyone holding the refresh token can read the mailbox's mail, not just the label. Store it in a secret manager or a protected env file, and revoke it at myaccount.google.com/permissions if it leaks. Prefer a dedicated mailbox or group address for the newsletter subscription where you can.

## 3. Pull

```bash
npx impactos gmail pull                       # label:ImpactOS-Funding-Source newer_than:30d
npx impactos gmail pull --query 'label:ImpactOS-Funding-Source after:2026/09/01' --max 100
npx impactos gmail pull --from ffwd.org --from news.example.org   # sender allowlist
```

Safe to run repeatedly:

- Messages already processed are skipped without being fetched.
- A message that fails is logged and **retried next run**, never silently lost.
- The **sender must be on the allowlist** (default `ffwd.org`). A matching subject alone is not trusted, so a spoofed "Funding Forward:" email from another sender is rejected and logged.

## 4. The whole path in one command

```bash
npx impactos run --profile examples/profile.json --sheet-id <sheet id>
```

Gmail pull → qualify new opportunities → two-way Google Sheet sync. Exit code 2 means at least one email failed (see `impactos audit`). To automate, run it from cron/launchd (for example every 30 minutes or weekly after the newsletter lands); run only one at a time, and keep the store file (`--store`) on that one machine.
