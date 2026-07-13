import { test, expect } from '@playwright/test';

/**
 * Wizard build tests — verifies a sample UCC app can be created end-to-end.
 * Uses aria roles rather than placeholder text to avoid Splunk UI substring-match ambiguity.
 */

// Helper: navigate through all wizard steps and generate an app
async function runWizard(
  page: import('@playwright/test').Page,
  opts: { appName?: string; version?: string } = {}
) {
  const appName = opts.appName ?? 'energy_usage_app';
  const version = opts.version ?? '1.0.0';

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.getByText('Create New App').click();
  await expect(page.getByRole('heading', { name: 'App Details' })).toBeVisible();

  // Splunk React UI Text inputs use aria-labelledby from ControlGroup label
  await page.getByRole('textbox', { name: 'App Name' }).fill(appName);
  await page.getByRole('textbox', { name: 'Version' }).fill(version);

  // Step through all wizard stages
  await page.getByRole('button', { name: 'Next' }).click(); // Details → Branding
  await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click(); // Branding → Components
  await expect(page.getByRole('heading', { name: 'Modular Inputs' })).toBeVisible(); // first heading in ComponentsStep
  await page.getByRole('button', { name: 'Next' }).click(); // Components → Review
  await expect(page.getByRole('heading', { name: 'Review & Generate' })).toBeVisible();

  await page.getByRole('button', { name: 'Generate App' }).click();
  await expect(page.getByText('globalConfig.json')).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  // Start fresh — clear any persisted VFS / wizard state
  await page.addInitScript(() => localStorage.clear());
});

test('wizard builds a sample app with correct file structure', async ({ page }) => {
  await runWizard(page);

  // Key generated files should appear in the file tree
  await expect(page.getByText('globalConfig.json')).toBeVisible();
  await expect(page.getByText('requirements.txt')).toBeVisible();

  // Download buttons should have the new names
  await expect(page.getByRole('button', { name: 'Download App' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export Source' })).toBeVisible();
});

test('requirements.txt contains splunktaucclib', async ({ page }) => {
  await runWizard(page, { appName: 'test_app' });

  // Click requirements.txt to open it in the Monaco editor
  await page.getByText('requirements.txt').click();

  // Monaco editor should show splunktaucclib as the first real dependency
  await expect(page.locator('.monaco-editor')).toContainText('splunktaucclib', { timeout: 8_000 });
});

test('local.meta is not generated', async ({ page }) => {
  await runWizard(page, { appName: 'no_local_meta_app' });

  // Check the full body text — local.meta should not appear anywhere
  const body = await page.locator('body').textContent();
  expect(body).not.toContain('local.meta');
});

test('license dropdown replaces the free-text fields', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByText('Create New App').click();
  await expect(page.getByRole('heading', { name: 'App Details' })).toBeVisible();

  // The old free-text "License Name" and "License URI" inputs should be gone;
  // they are now rendered as a Select (combobox role in Splunk UI v5)
  await expect(page.getByRole('textbox', { name: 'License Name' })).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: 'License URI' })).not.toBeVisible();

  // A combobox (the Select) should be visible in the license section
  // Splunk React UI Select renders as a button-like combobox; click to open it
  const licenseCombo = page.getByRole('combobox').or(
    page.locator('[data-test="select"]')
  ).first();
  await expect(licenseCombo).toBeVisible();
  await licenseCombo.click();

  // Standard OSS licenses should be listed in the dropdown
  await expect(page.getByText('MIT License').first()).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText('Apache License Version 2.0').first()).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText('Other (specify)').first()).toBeVisible({ timeout: 3_000 });

  // Dismiss
  await page.keyboard.press('Escape');
});

test('navigating to New App with existing project shows confirm dialog', async ({ page }) => {
  // Build a project first
  await runWizard(page, { appName: 'first_app' });
  await expect(page.getByRole('button', { name: 'Download App' })).toBeVisible();

  // Now register a handler before clicking — it should intercept the confirm() call
  let dialogMessage = '';
  page.once('dialog', async (d) => {
    dialogMessage = d.message();
    await d.dismiss(); // cancel — stay on current project
  });

  // Click the nav New App button — should trigger confirm since project is loaded
  await page.getByRole('button', { name: 'New App' }).click();

  // Allow dialog to be processed
  await page.waitForTimeout(600);

  expect(dialogMessage).toMatch(/existing project|discard/i);

  // We dismissed — project should still be in the files view
  await expect(page.getByRole('button', { name: 'Download App' })).toBeVisible();
});
