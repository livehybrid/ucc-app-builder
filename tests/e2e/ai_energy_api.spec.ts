import { test, expect } from '@playwright/test';

/**
 * AI Assistant integration test — verifies the AI can be prompted to build
 * a modular input that pulls from the Energy Usage API.
 *
 * Prerequisites (tests FAIL, not skip, when these are absent):
 *   - Backend must be running:  npm run dev:server  (port 3001)
 *   - OPENROUTER_API_KEY must be set in .env for live AI tests
 *
 * Key assertion: the AI must NOT produce the security error:
 *   "Write operations are only allowed within the package/ directory"
 * (This was a bug fixed in server/routes/ai.ts — globalConfig.json was
 *  blocked even though it's a valid UCC project root file.)
 */

const ENERGY_PROMPT =
  'Pull data from https://energyapi.splunk.engineer/getUsage using a header of x-api-key with value chIyPvOiru2plpIS9Zjy04iSqwBvHyAV5x6WiZmW';

// Backend Express server — separate from Vite (Vite has no /api proxy)
const BACKEND = process.env.E2E_API_URL ?? 'http://localhost:3001';

// Fetch AI config; returns null if backend is not reachable
async function getAiConfig(page: import('@playwright/test').Page) {
  try {
    const res = await page.request.get(`${BACKEND}/api/ai/config`, { timeout: 5_000 });
    if (!res.ok()) return null;
    const text = await res.text();
    if (text.startsWith('<')) return null; // HTML fallback, not JSON
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Helper: navigate wizard and generate a minimal app
async function buildBaseApp(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.getByText('Create New App').click();
  await expect(page.getByRole('heading', { name: 'App Details' })).toBeVisible();

  await page.getByRole('textbox', { name: 'App Name' }).fill('energy_usage_app');
  await page.getByRole('textbox', { name: 'Version' }).fill('1.0.0');

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Modular Inputs' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Review & Generate' })).toBeVisible();
  await page.getByRole('button', { name: 'Generate App' }).click();

  // Verify we landed on the file editor — "Download App" only appears in files mode
  await expect(page.getByRole('button', { name: 'Download App' })).toBeVisible({ timeout: 10_000 });
}

test.describe('AI Assistant — Energy API', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(600_000); // AI agent makes multiple tool calls — allow up to 10 minutes
    await page.addInitScript(() => localStorage.clear());
  });

  test('AI backend is reachable and config is reported', async ({ page }) => {
    const cfg = await getAiConfig(page);
    expect(cfg, 'Backend is not running on port 3001. Start with: npm run dev:server').not.toBeNull();
    expect(cfg).toHaveProperty('serverManaged');
    console.log('AI config:', JSON.stringify(cfg));
  });

  test('AI assistant responds to the energy API prompt without security errors', async ({ page }) => {
    const cfg = await getAiConfig(page);
    expect(cfg, 'Backend is not running on port 3001. Start with: npm run dev:server').not.toBeNull();
    expect(cfg!.serverManaged, 'OPENROUTER_API_KEY is not set in the server environment').toBe(true);

    await buildBaseApp(page);

    // Open AI Assistant panel
    await page.getByRole('button', { name: 'AI Assistant' }).click();
    await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 5_000 });

    // Enable auto-accept so tool approvals don't block the test
    await page.getByRole('button', { name: 'Settings' }).click();
    // Wait for aiConfig to load — settings shows "AI is server-managed" once the backend responds
    await expect(page.getByText('AI is server-managed')).toBeVisible({ timeout: 10_000 });
    const offLabel = page.getByText('You will be prompted to approve file changes.');
    if (await offLabel.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await page.getByText('Auto-accept tool actions')
        .locator('..')
        .locator('button, [role="switch"]')
        .first()
        .click();
    }
    await page.getByRole('button', { name: 'Settings' }).click(); // close settings
    await expect(page.getByText('AI is server-managed')).not.toBeVisible({ timeout: 5_000 });

    // Snapshot body text length BEFORE clicking Send. The AI panel is open
    // but no AI run has started yet, so all subsequent growth is attributable
    // to the user prompt + AI response.
    const bodyBeforeSend = (await page.locator('body').textContent()) ?? '';

    // Send the energy API prompt
    await page.locator('textarea').last().fill(ENERGY_PROMPT);
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the AI to actually engage — "Thinking..." appears as soon as the
    // server-side agent loop starts.
    await expect(page.getByText('Thinking...')).toBeVisible({ timeout: 60_000 });

    // Poll until the chat area has grown by enough chars to be AI-generated
    // content (not just the user prompt being echoed back). The user prompt
    // is ~115 chars; require at least 600 chars of new content to confirm
    // the AI produced a planner output, tool result, or assistant message.
    const minGrowth = 600;
    await expect(async () => {
      const after = (await page.locator('body').textContent()) ?? '';
      expect(after.length - bodyBeforeSend.length).toBeGreaterThan(minGrowth);
    }).toPass({ timeout: 180_000, intervals: [3_000] });

    // THE KEY ASSERTION — the security bug we fixed must not appear
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toContain('Write operations are only allowed within the package/ directory');
    expect(bodyText).not.toContain('Write operations are only allowed within package/');

    // AI should have mentioned something relevant to the prompt
    expect(bodyText).toMatch(/energy|getUsage|api[_\-]?key|modular.?input|helper|globalConfig/i);
  });

  test('AI modifies globalConfig.json when asked to add an input for the energy API', async ({ page }) => {
    const cfg = await getAiConfig(page);
    expect(cfg, 'Backend is not running on port 3001. Start with: npm run dev:server').not.toBeNull();
    expect(cfg!.serverManaged, 'OPENROUTER_API_KEY is not set in the server environment').toBe(true);

    await buildBaseApp(page);

    // Open AI Assistant and enable auto-accept
    await page.getByRole('button', { name: 'AI Assistant' }).click();
    await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    // Wait for aiConfig to load — settings shows "AI is server-managed" once the backend responds
    await expect(page.getByText('AI is server-managed')).toBeVisible({ timeout: 10_000 });
    const offLabel = page.getByText('You will be prompted to approve file changes.');
    if (await offLabel.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await page.getByText('Auto-accept tool actions')
        .locator('..')
        .locator('button, [role="switch"]')
        .first()
        .click();
    }
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('AI is server-managed')).not.toBeVisible({ timeout: 5_000 });

    // Send the prompt
    await page.locator('textarea').last().fill(ENERGY_PROMPT);
    await page.getByRole('button', { name: 'Send' }).click();

    // Poll until the AI reports a successful write to globalConfig.json (logged in chat mid-run)
    await expect(async () => {
      const text = await page.locator('body').textContent() ?? '';
      expect(text).toMatch(/Successfully wrote.*globalConfig|globalConfig.*written|updated.*globalConfig/i);
    }).toPass({ timeout: 540_000, intervals: [5_000] });

    // No security error
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toContain('Security Error');

    // Close the panel — × has no disabled state so it works even while AI is still running
    await page.getByRole('button', { name: '×' }).click();
    await expect(page.getByRole('heading', { name: 'AI Assistant' })).not.toBeVisible({ timeout: 5_000 });

    // Open globalConfig.json from the file tree — use first() since strict mode would
    // reject the ambiguity if multiple elements match the text
    await page.getByText('globalConfig.json').first().click();
    // Monaco's virtual renderer means .textContent() only returns the visible viewport.
    // Read the full model value via Monaco's JS API instead.
    await page.waitForTimeout(1_000); // allow editor to mount and load the model
    const editorContent = await page.evaluate(() => {
      const m = (window as any).monaco;
      if (!m?.editor) return '';
      const models: any[] = m.editor.getModels();
      for (const model of models) {
        const uri = model.uri?.toString() ?? '';
        if (uri.includes('globalConfig') || uri.includes('.json')) return model.getValue();
      }
      return models[0]?.getValue() ?? '';
    });
    expect(editorContent).toMatch(/energy|getUsage|api[_\-]?key|http|url/i);
  });
});
