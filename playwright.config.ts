import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the UCC App Builder UI.
 *
 * The e2e suite is HERMETIC: every backend call (/api/*) is mocked via page.route
 * inside the specs, so we only need the Vite front-end. We therefore start vite alone
 * — this also sidesteps the API port 3001 being occupied on some hosts.
 *
 * The dev port is 5273 (NOT vite's default 5173) so the suite never collides with a
 * developer's live `npm run dev` instance on 5173. Override with E2E_BASE_URL /
 * E2E_PORT if needed.
 *
 * To run against a real backend instead, start `npm run dev:all` yourself and set
 * E2E_SKIP_WEBSERVER=1.
 *
 * Usage:
 *   npm run test:e2e              # auto-starts vite on :5273, runs all e2e tests
 *   npm run test:e2e -- --ui      # interactive
 */
const E2E_PORT = process.env.E2E_PORT ?? '5273';
const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : {
        // FE only — the backend is fully mocked in the specs (page.route).
        // Pinned to :5273 to avoid colliding with a live dev server on :5173.
        command: `npm run dev -- --port ${E2E_PORT} --strictPort`,
        url: E2E_BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
