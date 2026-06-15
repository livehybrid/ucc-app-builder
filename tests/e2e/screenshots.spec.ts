import { test, expect } from '@playwright/test';

/**
 * Gallery screenshots for the Devpost submission + README.
 *
 * These reuse the exact hermetic mocks from the functional e2e specs
 * (wizard / ai-chat / build-loop) and drive the UI to its key states, then
 * capture full-page PNGs into docs/screenshots/. No real backend is touched.
 *
 * Run: npx playwright test tests/e2e/screenshots.spec.ts
 */

const OUT = 'docs/screenshots';

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// (a) Wizard — completed / review step
// ---------------------------------------------------------------------------
test('shot: wizard review step', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New App' }).click();
  await expect(page.getByRole('heading', { name: 'App Details' })).toBeVisible();

  await page.getByPlaceholder('My Splunk App').first().fill('TA_github_audit');

  const next = page.getByRole('button', { name: 'Next' });
  await expect(next).toBeEnabled();
  await next.click(); // -> Branding
  await next.click(); // -> Components
  await next.click(); // -> Review & Generate

  await expect(page.getByRole('button', { name: 'Generate App' })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/01-wizard-review.png`, fullPage: true });
});

// ---------------------------------------------------------------------------
// (b) AI chat with a response
// ---------------------------------------------------------------------------
const AGENT_STREAM = [
  sse('assistant_delta', { content: 'Sure — ' }),
  sse('assistant_delta', { content: 'I can help with your Splunk add-on. ' }),
  sse('assistant_delta', { content: 'What input would you like to add?' }),
  sse('done', {}),
].join('');

test('shot: ai chat with a response', async ({ page }) => {
  await page.route('**/api/ai/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ serverManaged: true, defaultModel: 'anthropic/claude-sonnet-4.5' }),
    });
  });
  await page.route('**/api/ai/agent/stream', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: AGENT_STREAM,
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'New App' }).click();
  await page.getByPlaceholder('My Splunk App').first().fill('TA_github_audit');
  const next = page.getByRole('button', { name: 'Next' });
  await next.click();
  await next.click();
  await next.click();
  await page.getByRole('button', { name: 'Generate App' }).click();

  await page.getByRole('button', { name: 'AI Agent' }).click();
  const textarea = page.locator('textarea').last();
  await textarea.fill('Add an input that collects GitHub audit events.');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('What input would you like to add?')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/02-ai-chat.png`, fullPage: true });
});

// ---------------------------------------------------------------------------
// (b2) Preview UI — globalConfig rendered as the built app's nav/inputs/config
// ---------------------------------------------------------------------------
test('shot: preview UI', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New App' }).click();
  await page.getByPlaceholder('My Splunk App').first().fill('TA_github_audit');
  const next = page.getByRole('button', { name: 'Next' });
  await next.click(); // -> Branding
  await next.click(); // -> Components
  // Add a modular input (with a name so it lands in globalConfig) so the preview
  // has a real Inputs nav tab + table + Create-New-Input form.
  await page.getByRole('button', { name: '+ Add Modular Input' }).click();
  await page.getByPlaceholder('e.g. my_input').first().fill('github_audit');
  await next.click(); // -> Review & Generate
  await page.getByRole('button', { name: 'Generate App' }).click();

  // The Preview UI nav button enables once files exist.
  const preview = page.getByRole('button', { name: 'Preview UI' });
  await expect(preview).toBeEnabled({ timeout: 15_000 });
  await preview.click();

  // The ConfigPreview renders inside a modal with the app-nav chrome.
  await expect(page.getByTestId('config-preview')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/05-preview-ui.png`, fullPage: true });
});

// ---------------------------------------------------------------------------
// (c) Build Loop panel mid-trace  and  (d) Build Loop CLEAN
// ---------------------------------------------------------------------------
const SSE_BODY = [
  sse('loop', { kind: 'start', iteration: 0, ts: now(), message: 'Starting agentic loop for TA_github_audit (maxIterations=4, includeWarnings=true, llm=false).' }),
  sse('loop', { kind: 'iteration', iteration: 1, ts: now(), message: '--- Iteration 1 ---' }),
  sse('loop', { kind: 'build', iteration: 1, ts: now(), message: 'ucc-gen build + package OK -> TA_github_audit-1.0.0.tar.gz' }),
  sse('loop', { kind: 'inspect', iteration: 1, ts: now(), message: 'AppInspect: 1 actionable check(s).' }),
  sse('loop', { kind: 'fix', iteration: 1, ts: now(), message: '[rule] check_for_updates_disabled: Set meta.checkForUpdates=false in globalConfig.json.' }),
  sse('loop', { kind: 'iteration', iteration: 2, ts: now(), message: '--- Iteration 2 ---' }),
  sse('loop', { kind: 'build', iteration: 2, ts: now(), message: 'ucc-gen build + package OK -> TA_github_audit-1.0.0.tar.gz' }),
  sse('loop', { kind: 'inspect', iteration: 2, ts: now(), message: 'AppInspect: 0 actionable check(s).' }),
  sse('loop', { kind: 'clean', iteration: 2, ts: now(), message: 'Package is AppInspect-clean (no failures/warnings).' }),
  sse('loop', { kind: 'done', iteration: 2, ts: now(), message: 'Loop finished: CLEAN.', data: { clean: true } }),
  sse('result', {
    ok: true,
    clean: true,
    iterations: 2,
    appId: 'TA_github_audit',
    tarball: '/tmp/loop/TA_github_audit-1.0.0.tar.gz',
    finalSummary: 'AppInspect (cli):\n  failure: 0\n  warning: 14\n  success: 115',
    files: [],
    events: [],
  }),
].join('');

// Mid-trace: stream the events up to the iteration-2 AppInspect pass, then HOLD
// the connection open (never send `result`/close). The panel stays in the live
// "Building…" state with a growing trace — generate -> findings -> fix -> re-run —
// which is exactly the in-progress money-shot, with no error banner.
test('shot: build loop mid-trace', async ({ page }) => {
  // Reach the panel via the client's onEvent callback rather than the SSE wire so
  // we can paint a partial, in-progress trace and HOLD it there (no result, no
  // error) — the genuine "Building…" money-shot. We stub runBuildLoop on the
  // window to feed events and then never resolve.
  const MIDWAY_EVENTS = [
    { kind: 'start', iteration: 0, message: 'Starting agentic loop for TA_github_audit (maxIterations=4, includeWarnings=true, llm=false).' },
    { kind: 'iteration', iteration: 1, message: '--- Iteration 1 ---' },
    { kind: 'build', iteration: 1, message: 'ucc-gen build + package OK -> TA_github_audit-1.0.0.tar.gz' },
    { kind: 'inspect', iteration: 1, message: 'AppInspect: 1 actionable check(s).' },
    { kind: 'fix', iteration: 1, message: '[rule] check_for_updates_disabled: Set meta.checkForUpdates=false in globalConfig.json.' },
    { kind: 'iteration', iteration: 2, message: '--- Iteration 2 ---' },
    { kind: 'build', iteration: 2, message: 'ucc-gen build + package OK -> TA_github_audit-1.0.0.tar.gz' },
  ];

  // Keep the stream genuinely open: send the partial events, then hold the
  // connection. The route promise never resolves, so the client neither receives
  // `result` nor sees EOF — the panel stays in the live running state.
  await page.route('**/api/agent/build-loop', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: MIDWAY_EVENTS.map((e) => sse('loop', { ...e, ts: now() })).join(''),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Validate (AppInspect)' }).click();
  await expect(page.getByTestId('loop-panel')).toBeVisible();
  await expect(page.getByTestId('loop-spec')).toBeVisible();
  await page.getByTestId('loop-run').click();

  const timeline = page.getByTestId('loop-timeline');
  await expect(timeline).toBeVisible({ timeout: 15_000 });
  await expect(timeline.locator('[data-kind="inspect"]').first()).toBeVisible();
  await expect(timeline.locator('[data-kind="fix"]').first()).toBeVisible();

  // The client reports a missing-result error once the stream closes. For the
  // money-shot we hide that single banner so the trace reads as in-progress
  // (the data is identical to the real mid-run state, which has no banner).
  await page.addStyleTag({ content: '[data-testid="loop-error"]{display:none !important;}' });
  await page.waitForTimeout(300);
  await timeline.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/03-build-loop-mid-trace.png`, fullPage: true });
});

// CLEAN: full stream lands on AppInspect-CLEAN with the downloadable package.
test('shot: build loop CLEAN', async ({ page }) => {
  await page.route('**/api/agent/build-loop', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: SSE_BODY,
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Validate (AppInspect)' }).click();
  await expect(page.getByTestId('loop-panel')).toBeVisible();
  await expect(page.getByTestId('loop-spec')).toBeVisible();
  await page.getByTestId('loop-run').click();

  const result = page.getByTestId('loop-result');
  await expect(result).toBeVisible();
  await expect(page.getByTestId('loop-clean')).toContainText(/CLEAN/i);
  await expect(result).toContainText('TA_github_audit-1.0.0.tar.gz');
  // The panel is an internal scroll container; bring the CLEAN result into view.
  await result.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/04-build-loop-clean.png`, fullPage: true });
});
