import { test, expect } from '@playwright/test';

/**
 * Run History — the durable Splunk Agent SDK trace viewer. Gated on splunkMode
 * (__UCC_SPLUNK_AGENT__) and backed by the loader's __UCC_SPLUNK_FETCH__ helper
 * (/agent_traces, /agent_trace). We inject a hermetic mock of both globals so the
 * History button renders and the modal drives end-to-end with no backend.
 */
const SPLUNK_MOCK = `
window.__UCC_SPLUNK_AGENT__ = true;
window.__UCC_TRACES__ = {
  aaa: {
    job_id: 'aaa', prompt: 'Add a GitHub audit input', model: 'anthropic/claude-sonnet-4.6',
    status: 'done', step_count: 3, event_count: 7, created_at: 1782000000,
    answer: 'Done — created the add-on.',
    events: [
      { event: 'assistant', content: 'Working on your GitHub input' },
      { event: 'tool_call', name: 'create_addon', args: { name: 'gh' } },
      { event: 'tool_result', result: 'ok' },
      { event: 'done', answer: 'Done — created the add-on.' },
    ],
  },
};
window.__UCC_SPLUNK_FETCH__ = (path, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  const reply = (obj, status) =>
    Promise.resolve(new Response(JSON.stringify(obj), {
      status: status || 200, headers: { 'Content-Type': 'application/json' },
    }));
  if (path === '/agent_traces') {
    const rows = Object.values(window.__UCC_TRACES__).map((t) => ({
      job_id: t.job_id, prompt: t.prompt, model: t.model, status: t.status,
      step_count: t.step_count, event_count: t.event_count, created_at: t.created_at,
    }));
    return reply({ ok: true, traces: rows });
  }
  if (path === '/agent_trace') {
    const t = window.__UCC_TRACES__[body.job_id];
    return t ? reply({ ok: true, found: true, trace: t }) : reply({ ok: true, found: false }, 404);
  }
  return reply({ ok: true });
};
`;

test('Run History lists past agent runs and opens a full trace', async ({ page }) => {
  // Keep on-load config fetches quiet (splunkMode still renders fine on empty config).
  await page.route('**/api/ai/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  await page.addInitScript(SPLUNK_MOCK);
  await page.goto('/');

  // Open the AI Assistant — the History button renders only in splunkMode.
  await page.getByRole('button', { name: 'AI Agent' }).click();
  const history = page.getByRole('button', { name: /History/ });
  await expect(history).toBeVisible();
  await history.click();

  // List view: the run appears with its prompt preview.
  await expect(page.getByRole('heading', { name: 'Run history' })).toBeVisible();
  await expect(page.getByText('Add a GitHub audit input')).toBeVisible();

  // Open the trace: the full event stream renders read-only.
  await page.getByText('Add a GitHub audit input').click();
  await expect(page.getByRole('heading', { name: 'Run trace' })).toBeVisible();
  await expect(page.getByText('Working on your GitHub input')).toBeVisible();
  await expect(page.getByText(/create_addon/)).toBeVisible();
  await expect(page.getByText(/Done — created the add-on\./).first()).toBeVisible();

  // Back to the list.
  await page.getByRole('button', { name: /Back to list/ }).click();
  await expect(page.getByRole('heading', { name: 'Run history' })).toBeVisible();
});
