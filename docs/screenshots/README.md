# Screenshots

UI screenshots for the Devpost gallery and project README. Each shot is captured
by `tests/e2e/screenshots.spec.ts`, which reuses the hermetic e2e mocks (every
`/api/*` call is intercepted via `page.route` — no backend, no live Splunk) and
drives the real UI to the state shown.

Regenerate them with:

```bash
npx playwright test tests/e2e/screenshots.spec.ts
```

| File | What it shows |
| --- | --- |
| `01-wizard-review.png` | The New App wizard on the **Review & Generate** step — app details, components, and the live `globalConfig.json` preview before generation. |
| `02-ai-chat.png` | The **AI Assistant** panel answering a request to add a GitHub-audit input, with the generated app's file tree alongside. |
| `03-build-loop-mid-trace.png` | The **Agentic AppInspect Build Loop** mid-run: generate → AppInspect findings (1 actionable check) → auto-fix → re-run into iteration 2. |
| `04-build-loop-clean.png` | The Build Loop landed on **AppInspect-CLEAN** (failure: 0) with the downloadable package `TA_github_audit-1.0.0.tar.gz`. |
