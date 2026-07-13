import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the UCC App Builder UI.
 *
 * Usage:
 *   npm run dev:all               # start vite + server
 *   npm run test:e2e              # run all e2e tests
 *   npm run test:e2e -- --ui      # interactive
 *
 * CI uses this config with `--reporter=github` — see `.github/workflows/`
 * (added in a follow-up PR).
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Local: 1 retry to absorb intermittent AI model variance in the live AI tests
  // (the energy-API e2e occasionally has the AI read globalConfig.json then fail
  //  to write it back — kimi-k2.6 behaves non-deterministically). CI: 2 retries.
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
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
    : [
        {
          command: 'npm run dev',
          url: 'http://localhost:5173',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
        {
          command: 'npm run dev:server',
          url: 'http://localhost:3001/api/health',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'ignore',
          stderr: 'pipe',
          // Disable post-agent ucc-gen validation in e2e to keep test 3 under
          // ~10min. Validation is exercised in interactive use; the e2e suite
          // is verifying agent loop logic, not ucc-gen integration.
          env: { UCC_AGENT_AUTO_VALIDATE: 'false' },
        },
      ],
});
