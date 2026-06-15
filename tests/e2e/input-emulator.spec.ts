import { test, expect } from '@playwright/test';

/**
 * "Test Input" — the input emulator: run a modular input's collection code with
 * user-supplied values (server-side, real HTTP, no install) and see the events it would
 * index. The UI discovers `<input>_helper.py` files in the generated project's VFS, posts
 * to /api/emulate/input, and renders the captured events.
 *
 * Here we generate a project WITH a modular input via the wizard (so the emulator has a
 * helper to discover), mock /api/emulate/input, and assert the run renders the events.
 * (The Python harness itself is covered by server/routes/emulate.test.ts.)
 */
test('Test Input emulates a discovered modular input and renders events', async ({ page }) => {
  // Mock the emulation endpoint: return one event + a log line, as the harness would.
  await page.route('**/api/emulate/input', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        count: 1,
        truncated: false,
        events: [
          { data: '{"temp": 21, "city": "leeds"}', sourcetype: 'weatherapi:obs', index: 'main' },
        ],
        logs: ['[INFO] collecting weatherapi'],
      }),
    })
  );

  await page.goto('/');

  // Wizard -> add a modular input named "weatherapi" -> generate.
  await page.getByRole('button', { name: 'New App' }).click();
  await page.getByPlaceholder('My Splunk App').first().fill('e2e_emulate');
  const next = page.getByRole('button', { name: 'Next' });
  await next.click(); // Branding
  await next.click(); // Components
  await page.getByRole('button', { name: '+ Add Modular Input' }).click();
  await page.getByPlaceholder('e.g. my_input').fill('weatherapi');
  await next.click(); // Review
  await page.getByRole('button', { name: 'Generate App' }).click();
  await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeVisible({ timeout: 15_000 });

  // Open the emulator.
  await page.getByRole('button', { name: 'Test Input' }).click();
  const dialog = page.getByRole('dialog', { name: /Test Input/ });
  await expect(dialog.getByRole('heading', { name: /Test Input/ })).toBeVisible();

  // Select the discovered input (Splunk Select renders role=combobox; options role=option).
  await dialog.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'weatherapi' }).click();

  // Run -> the mocked endpoint returns one event, which is rendered.
  await dialog.getByRole('button', { name: /Run emulation/ }).click();
  await expect(dialog.getByText(/1 event captured/)).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText(/"city": "leeds"/)).toBeVisible();
});

test('Test Input shows guidance when the project has no modular inputs', async ({ page }) => {
  await page.goto('/');

  // Generate the default app (no modular input).
  await page.getByRole('button', { name: 'New App' }).click();
  await page.getByPlaceholder('My Splunk App').first().fill('e2e_noinput');
  const next = page.getByRole('button', { name: 'Next' });
  await next.click(); // Branding
  await next.click(); // Components
  await next.click(); // Review
  await page.getByRole('button', { name: 'Generate App' }).click();
  await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Test Input' }).click();
  await expect(page.getByRole('heading', { name: /Test Input/ })).toBeVisible();
  await expect(page.getByText(/No modular inputs found/)).toBeVisible();
});
