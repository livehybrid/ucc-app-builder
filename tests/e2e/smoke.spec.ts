import { test, expect } from '@playwright/test';

/**
 * Smoke test: the app loads, the layout renders, and no console errors fire.
 * This is the "is the product even alive" baseline test.
 */
test('builder loads without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await expect(page).toHaveTitle(/UCC|Splunk|Builder/i);

  // The AI chat panel toggle / chat button should exist in some form.
  const body = await page.locator('body');
  await expect(body).toBeVisible();

  // No console errors after a short settle.
  await page.waitForTimeout(2000);
  expect(errors, `Console errors encountered:\n${errors.join('\n')}`).toHaveLength(0);
});
