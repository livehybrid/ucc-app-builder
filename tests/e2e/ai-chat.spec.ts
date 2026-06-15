import { test, expect } from '@playwright/test';

/**
 * AI chat responds: with an add-on generated, the user opens the AI Assistant,
 * sends a message, and an assistant reply renders. Hermetic: we force the
 * server-managed path via /api/ai/config and replay a canned SSE stream from
 * /api/ai/agent/stream (assistant_delta tokens) so no real LLM is called.
 */

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const AGENT_STREAM = [
  sse('assistant_delta', { content: 'Sure — ' }),
  sse('assistant_delta', { content: 'I can help with your Splunk add-on. ' }),
  sse('assistant_delta', { content: 'What input would you like to add?' }),
  sse('done', {}),
].join('');

test('AI chat responds to a message', async ({ page }) => {
  await page.route('**/api/ai/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ serverManaged: true, defaultModel: 'anthropic/claude-sonnet-4.5' }),
    });
  });
  await page.route('**/api/ai/agent/stream', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: AGENT_STREAM,
    });
  });

  await page.goto('/');

  // The AI Agent assistant lives in the top nav and is always available — open it.
  await page.getByRole('button', { name: 'AI Agent' }).click();

  // Type a message and send.
  const textarea = page.locator('textarea').last();
  await textarea.fill('Add an input that collects GitHub audit events.');
  await page.getByRole('button', { name: 'Send' }).click();

  // The assistant reply (streamed from the mocked SSE) should render.
  await expect(page.getByText('What input would you like to add?')).toBeVisible({ timeout: 15_000 });
});
