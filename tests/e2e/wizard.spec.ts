import { test, expect } from '@playwright/test';

/**
 * Wizard happy path: a user walks App Details -> Branding -> Components -> Review
 * and generates an app. Completion is observable: the app switches to the Files
 * view and the header exposes the "Download ZIP" action for the generated package.
 */
test('wizard completes and generates an app', async ({ page }) => {
  await page.goto('/');

  // Enter via the New App nav button.
  await page.getByRole('button', { name: 'New App' }).click();
  await expect(page.getByRole('heading', { name: 'App Details' })).toBeVisible();

  // App Name is required to proceed (version defaults to 1.0.0).
  const appName = page.getByPlaceholder('My Splunk App').first();
  await appName.fill('e2e_demo_app');

  // Step through to the final Review step.
  const next = page.getByRole('button', { name: 'Next' });
  await expect(next).toBeEnabled();
  await next.click(); // -> Branding
  await next.click(); // -> Components
  await next.click(); // -> Review & Generate

  const generate = page.getByRole('button', { name: 'Generate App' });
  await expect(generate).toBeVisible();
  await expect(generate).toBeEnabled();
  await generate.click();

  // Completion: app moved to Files view -> Download ZIP is now available.
  await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeVisible({ timeout: 15_000 });
  // The Files nav entry is now active/enabled.
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeEnabled();
});

test('wizard blocks Next until the required App Name is provided', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New App' }).click();
  await expect(page.getByRole('heading', { name: 'App Details' })).toBeVisible();

  // With no app name, Next is disabled.
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();

  await page.getByPlaceholder('My Splunk App').first().fill('valid_name');
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
});
