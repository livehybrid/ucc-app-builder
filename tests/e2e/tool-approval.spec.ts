import { test, expect } from '@playwright/test';

/**
 * Tool-approval policy UI (hermetic).
 *
 * The server-managed agent stream emits an `approval_request` SSE frame before an
 * `ask`-policy external tool runs. The browser renders an approval card (tool name,
 * args, a one-line reason, three buttons) and POSTs the decision to
 * POST /api/ai/agent/approve, which resumes the run.
 *
 * Everything is mocked via page.route (no real LLM / MCP). We replay a canned SSE
 * body containing the approval_request followed by the continuation, capture the
 * approve POST to assert the decision the user picked, and verify the run continues.
 * Runs on port 5273 (playwright.config), never 5173.
 */

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const CONFIG_BODY = {
  serverManaged: true,
  defaultModel: 'anthropic/claude-sonnet-4.5',
  toolPolicy: {
    policy: { run_splunk_query: 'ask', write_file: 'auto', build_and_inspect: 'auto' },
    askTools: ['get_live_indexes', 'get_splunk_metadata', 'run_splunk_query', 'generate_spl'],
    mcpGroundingAuto: false,
  },
};

// One canned stream: emit the approval_request, then (as if the user had approved)
// the assistant continuation + done. The card-render + approve-POST is what we
// assert; the continuation proves the UI resumes.
const STREAM_BODY = [
  sse('approval_request', {
    approvalId: 'apr_test_1',
    tool: 'run_splunk_query',
    args: { query: 'index=_internal | head 5' },
    reason: '"run_splunk_query" has external access (it can reach outside this build sandbox). Approve once, approve for the session, or deny.',
  }),
  sse('assistant_delta', { content: 'Ran the live search — ' }),
  sse('assistant_delta', { content: 'here are your results.' }),
  sse('done', {}),
].join('');

async function setupRoutes(page: import('@playwright/test').Page, approveCalls: Array<{ approvalId: string; decision: string }>) {
  await page.route('**/api/ai/config', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONFIG_BODY) });
  });
  await page.route('**/api/ai/agent/stream', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: STREAM_BODY,
    });
  });
  await page.route('**/api/ai/agent/approve', async (route) => {
    const post = route.request().postDataJSON() as { approvalId: string; decision: string };
    approveCalls.push(post);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...post }) });
  });
}

test('approval card renders and "Approve for session" resumes the run', async ({ page }) => {
  const approveCalls: Array<{ approvalId: string; decision: string }> = [];
  await setupRoutes(page, approveCalls);

  await page.goto('/');
  await page.getByRole('button', { name: 'AI Agent' }).click();

  const textarea = page.locator('textarea').last();
  await textarea.fill('Use my real indexes to verify the sourcetype.');
  await page.getByRole('button', { name: 'Send' }).click();

  // The approval card renders with the tool name, the reason, and three buttons.
  await expect(page.getByText('Review AI Changes: run_splunk_query')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('approval-reason')).toContainText('external access');
  await expect(page.getByTestId('approval-approve')).toBeVisible();
  await expect(page.getByTestId('approval-approve-session')).toBeVisible();
  await expect(page.getByTestId('approval-deny')).toBeVisible();

  // Approve for the session → POSTs approve_session and the run continues.
  await page.getByTestId('approval-approve-session').click();

  await expect.poll(() => approveCalls.length).toBeGreaterThan(0);
  expect(approveCalls[0]).toMatchObject({ approvalId: 'apr_test_1', decision: 'approve_session' });

  // The continuation streamed after approval renders.
  await expect(page.getByText('here are your results.')).toBeVisible({ timeout: 15_000 });
});

test('Deny on the approval card sends a deny decision', async ({ page }) => {
  const approveCalls: Array<{ approvalId: string; decision: string }> = [];
  await setupRoutes(page, approveCalls);

  await page.goto('/');
  await page.getByRole('button', { name: 'AI Agent' }).click();

  const textarea = page.locator('textarea').last();
  await textarea.fill('Use my real indexes.');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Review AI Changes: run_splunk_query')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('approval-deny').click();

  await expect.poll(() => approveCalls.length).toBeGreaterThan(0);
  expect(approveCalls[0]).toMatchObject({ approvalId: 'apr_test_1', decision: 'deny' });
});

test('Settings exposes the tool-approval policy with per-tool toggles', async ({ page }) => {
  const approveCalls: Array<{ approvalId: string; decision: string }> = [];
  await setupRoutes(page, approveCalls);

  await page.goto('/');
  await page.getByRole('button', { name: 'AI Agent' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();

  const policySection = page.getByTestId('tool-policy-settings');
  await expect(policySection).toBeVisible();
  // The external/ask tools are listed with a toggle.
  await expect(page.getByTestId('tool-policy-row-run_splunk_query')).toBeVisible();
  const toggle = page.getByTestId('tool-policy-toggle-run_splunk_query');
  await expect(toggle).toBeVisible();
  // Defaults to "Always ask" for an external tool.
  await expect(toggle).toContainText('Always ask');
});
