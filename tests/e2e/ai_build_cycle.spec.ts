import { test, expect, type Page } from '@playwright/test';

/**
 * End-to-end: full AI → ucc-gen build cycle for the Energy Usage API.
 *
 * This test suite covers the complete workflow that was previously manual:
 *   1. Create a new app via the wizard
 *   2. Open AI Assistant, send the standard energy-API prompt
 *   3. Wait for the agent loop to finish (no more tool calls)
 *   4. Assert no security errors or Python syntax errors from the agent
 *   5. Trigger a real ucc-gen build via the BuildPanel
 *   6. Assert the build succeeds and the built-app download is available
 *
 * Prerequisites (tests FAIL, not skip, when these are absent):
 *   - npm run dev:all  (Vite on :5173 + Express on :3001)
 *   - OPENROUTER_API_KEY set in the server environment
 */

const ENERGY_PROMPT =
  'Pull data from https://energyapi.splunk.engineer/getUsage using a header of x-api-key with value chIyPvOiru2plpIS9Zjy04iSqwBvHyAV5x6WiZmW';

const BACKEND = process.env.E2E_API_URL ?? 'http://localhost:3001';

async function getAiConfig(page: Page) {
  try {
    const res = await page.request.get(`${BACKEND}/api/ai/config`, { timeout: 5_000 });
    if (!res.ok()) return null;
    const text = await res.text();
    if (text.startsWith('<')) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Assert that the backend is reachable and the AI key is configured.
 * Throws (fails the test) rather than skipping if either condition is not met.
 */
async function requireAi(page: Page) {
  const cfg = await getAiConfig(page);
  expect(
    cfg,
    `Backend is not running on port 3001. Start it with: npm run dev:all`
  ).not.toBeNull();
  expect(
    cfg!.serverManaged,
    `OPENROUTER_API_KEY is not set in the server environment. ` +
      `Add it to .env and restart the server.`
  ).toBe(true);
  return cfg!;
}

/** Navigate the wizard and land on the files view. */
async function runWizard(page: Page, appName = 'energy_usage_app') {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.getByText('Create New App').click();
  await expect(page.getByRole('heading', { name: 'App Details' })).toBeVisible();

  await page.getByRole('textbox', { name: 'App Name' }).fill(appName);
  await page.getByRole('textbox', { name: 'Version' }).fill('1.0.0');

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Modular Inputs' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Review & Generate' })).toBeVisible();

  await page.getByRole('button', { name: 'Generate App' }).click();
  await expect(page.getByText('globalConfig.json')).toBeVisible({ timeout: 10_000 });
}

/** Open AI Assistant panel and enable auto-accept. */
async function openAiAndAutoAccept(page: Page) {
  await page.getByRole('button', { name: 'AI Assistant' }).click();
  await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 5_000 });

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('AI is server-managed')).toBeVisible({ timeout: 10_000 });

  const offLabel = page.getByText('You will be prompted to approve file changes.');
  if (await offLabel.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await page
      .getByText('Auto-accept tool actions')
      .locator('..')
      .locator('button, [role="switch"]')
      .first()
      .click();
  }

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('AI is server-managed')).not.toBeVisible({ timeout: 5_000 });
}

test.describe('AI → Build cycle (Energy API)', () => {
  test.beforeEach(async ({ page }) => {
    // 10 min — AI agent + ucc-gen build can take several minutes
    test.setTimeout(600_000);
    await page.addInitScript(() => localStorage.clear());
  });

  test('AI generates valid Python: no IndentationError refused writes', async ({ page }) => {
    await requireAi(page);

    await runWizard(page);
    await openAiAndAutoAccept(page);

    const bodyBefore = (await page.locator('body').textContent()) ?? '';

    await page.locator('textarea').last().fill(ENERGY_PROMPT);
    await page.getByRole('button', { name: 'Send' }).click();

    // AI must start within 60 s
    await expect(page.getByText('Thinking...')).toBeVisible({ timeout: 60_000 });

    // Wait for AI to finish — "Thinking..." disappears when isLoading goes false
    await expect(page.getByText('Thinking...')).not.toBeVisible({ timeout: 540_000 });

    const bodyAfter = (await page.locator('body').textContent()) ?? '';

    // AI must have produced content
    expect(bodyAfter.length - bodyBefore.length).toBeGreaterThan(300);

    // Core assertions: no security/syntax errors were emitted by the agent
    expect(bodyAfter).not.toContain('Security Error');
    expect(bodyAfter).not.toContain('IndentationError');
    expect(bodyAfter).not.toContain('SyntaxError');
    expect(bodyAfter).not.toContain('Refused write');
    expect(bodyAfter).not.toContain('Refused create');

    // Agent must have mentioned the energy API or written relevant files
    expect(bodyAfter).toMatch(/energy|getUsage|api[_\-]?key|globalConfig|helper/i);
  });

  test('build succeeds after AI generates the energy API input', async ({ page }) => {
    await requireAi(page);

    await runWizard(page);
    await openAiAndAutoAccept(page);

    // Send prompt and wait for completion
    await page.locator('textarea').last().fill(ENERGY_PROMPT);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Thinking...')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Thinking...')).not.toBeVisible({ timeout: 540_000 });

    // Close AI panel so build controls are fully accessible
    await page.getByRole('button', { name: '×' }).click();
    await expect(page.getByRole('heading', { name: 'AI Assistant' })).not.toBeVisible({ timeout: 5_000 });

    // Trigger the ucc-gen build
    await page.getByRole('button', { name: 'Build App' }).click();
    await expect(page.getByRole('button', { name: 'Building...' })).toBeVisible({ timeout: 10_000 });

    // Wait for build to finish — "Build App" re-enables when isBuilding goes false (success or failure)
    await expect(page.getByRole('button', { name: 'Build App' })).toBeEnabled({ timeout: 120_000 });

    const downloadBtn = page.getByRole('button', { name: 'Download Built App' });
    const buildLogs = page.locator('pre').last();
    const logsText = await buildLogs.textContent().catch(() => '');

    // ucc-gen not installed → skip (separate infrastructure dependency, not a code bug)
    if (logsText?.includes('ENOENT') || logsText?.includes('ucc-gen not found')) {
      test.skip(true, 'ucc-gen is not installed in this environment');
    }

    await expect(downloadBtn).toBeVisible({ timeout: 5_000 });
    expect(logsText).not.toContain('IndentationError');
    expect(logsText).not.toContain('SyntaxError');
    expect(logsText).not.toContain('Traceback');
  });

  test('agent stream endpoint is reachable', async ({ page }) => {
    const cfg = await getAiConfig(page);
    expect(cfg, 'Backend is not running on port 3001. Start with: npm run dev:all').not.toBeNull();

    const res = await page.request.post(`${BACKEND}/api/ai/agent/stream`, {
      data: {
        sessionId: 'e2e-tool-check',
        messages: [{ role: 'user', content: 'list_files' }],
        files: [],
        maxIterations: 1,
        autoValidate: false,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });

    // 200 = server-managed, 403 = no key configured — both are valid responses
    // 500 means the endpoint itself is broken
    expect(res.status()).not.toBe(500);
  });
});

test.describe('Build wizard cycle (no AI)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
  });

  test('Build App button is present after wizard completes', async ({ page }) => {
    await runWizard(page, 'build_button_test');
    await expect(page.getByRole('button', { name: 'Build App' })).toBeVisible({ timeout: 5_000 });
  });

  test('ucc-gen build runs and reports a result for a minimal app', async ({ page }) => {
    test.setTimeout(120_000);

    await runWizard(page, 'minimal_build_test');
    await page.getByRole('button', { name: 'Build App' }).click();
    await expect(page.getByRole('button', { name: 'Building...' })).toBeVisible({ timeout: 10_000 });

    // Wait for build to finish — "Build App" re-enables when isBuilding goes false (success or failure)
    await expect(page.getByRole('button', { name: 'Build App' })).toBeEnabled({ timeout: 90_000 });

    const downloadBtn = page.getByRole('button', { name: 'Download Built App' });
    const logsEl = page.locator('pre').last();
    const logsText = await logsEl.textContent().catch(() => '');

    if (logsText?.includes('ENOENT') || logsText?.includes('ucc-gen not found')) {
      test.skip(true, 'ucc-gen is not installed — skipping build result assertion');
    }

    await expect(downloadBtn).toBeVisible({ timeout: 5_000 });
    expect(logsText).not.toContain('IndentationError');
    expect(logsText).not.toContain('SyntaxError');
  });
});
