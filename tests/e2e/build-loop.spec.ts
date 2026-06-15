import { test, expect } from '@playwright/test';

/**
 * The money-shot: the Build Loop panel renders a live agentic trace that lands on
 * AppInspect-CLEAN with a downloadable package.
 *
 * Hermetic by design: the real loop runs `ucc-gen` + `splunk-appinspect` for minutes,
 * so we intercept POST /api/agent/build-loop and replay a CANNED Server-Sent-Events
 * stream of loop events (generate -> inspect -> fix -> inspect -> clean -> done) plus
 * a final `result` event with clean:true. This exercises the panel's SSE parsing and
 * rendering end-to-end without the toolchain. (The real loop reaching CLEAN is proven
 * separately by the `loop-smoke` CI job.)
 */

const SSE_BODY = [
  // event: loop  (one block per loop event)
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

function now() {
  return new Date().toISOString();
}
function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test('Build Loop panel streams a trace to AppInspect-CLEAN', async ({ page }) => {
  // Intercept the loop endpoint and replay the canned SSE stream.
  await page.route('**/api/agent/build-loop', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: SSE_BODY,
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Validate (AppInspect)' }).click();

  const panel = page.getByTestId('loop-panel');
  await expect(panel).toBeVisible();

  // A default spec is pre-filled; just run it.
  await expect(page.getByTestId('loop-spec')).toBeVisible();
  await page.getByTestId('loop-run').click();

  // The live trace appears and contains the key loop stages.
  const timeline = page.getByTestId('loop-timeline');
  await expect(timeline).toBeVisible({ timeout: 15_000 });
  await expect(timeline.locator('[data-kind="inspect"]').first()).toBeVisible();
  await expect(timeline.locator('[data-kind="fix"]').first()).toBeVisible();
  await expect(timeline.locator('[data-kind="clean"]')).toBeVisible();

  // Final result: CLEAN, with the package surfaced.
  await expect(page.getByTestId('loop-result')).toBeVisible();
  await expect(page.getByTestId('loop-clean')).toContainText(/CLEAN/i);
  await expect(page.getByTestId('loop-result')).toContainText('TA_github_audit-1.0.0.tar.gz');
});

test('Build Loop panel surfaces a stream error gracefully', async ({ page }) => {
  await page.route('**/api/agent/build-loop', async (route) => {
    await route.fulfill({ status: 500, body: 'boom' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Validate (AppInspect)' }).click();
  await page.getByTestId('loop-run').click();

  await expect(page.getByTestId('loop-error')).toBeVisible({ timeout: 15_000 });
});
