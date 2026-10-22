# Contributing

Thanks for helping! Most valuable right now: **anonymized newsletter fixtures**, parser fixes, adapters, and evaluator improvements.

```bash
npm install
npm test          # vitest
npm run typecheck
```

- Open an issue before large changes.
- Add or update tests; parsing changes need a fixture.
- Keep the human-decision boundary intact (see [docs/decision-policy.md](docs/decision-policy.md)). PRs that let the system submit applications or auto-resolve ambiguous eligibility will not be accepted.
- Never commit real organizational data, credentials, or personal information in fixtures.
- Commits: short imperative subject. By contributing you agree your work is licensed under Apache-2.0.
