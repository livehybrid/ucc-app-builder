# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ai_build_cycle.spec.ts >> AI → Build cycle (Energy API) >> AI generates valid Python: no IndentationError refused writes
- Location: tests/e2e/ai_build_cycle.spec.ts:105:3

# Error details

```
Error: Channel closed
```

```
Error: expect(locator).not.toBeVisible() failed

Locator:  getByText('Thinking...')
Expected: not visible
Received: visible

Call log:
  - Expect "not toBeVisible" with timeout 540000ms
  - waiting for getByText('Thinking...')
    400 × locator resolved to <span>Thinking...</span>
        - unexpected value "visible"

```

# Test source

```ts
  20  |   'Pull data from https://energyapi.splunk.engineer/getUsage using a header of x-api-key with value chIyPvOiru2plpIS9Zjy04iSqwBvHyAV5x6WiZmW';
  21  | 
  22  | const BACKEND = process.env.E2E_API_URL ?? 'http://localhost:3001';
  23  | 
  24  | async function getAiConfig(page: Page) {
  25  |   try {
  26  |     const res = await page.request.get(`${BACKEND}/api/ai/config`, { timeout: 5_000 });
  27  |     if (!res.ok()) return null;
  28  |     const text = await res.text();
  29  |     if (text.startsWith('<')) return null;
  30  |     return JSON.parse(text);
  31  |   } catch {
  32  |     return null;
  33  |   }
  34  | }
  35  | 
  36  | /**
  37  |  * Assert that the backend is reachable and the AI key is configured.
  38  |  * Throws (fails the test) rather than skipping if either condition is not met.
  39  |  */
  40  | async function requireAi(page: Page) {
  41  |   const cfg = await getAiConfig(page);
  42  |   expect(
  43  |     cfg,
  44  |     `Backend is not running on port 3001. Start it with: npm run dev:all`
  45  |   ).not.toBeNull();
  46  |   expect(
  47  |     cfg!.serverManaged,
  48  |     `OPENROUTER_API_KEY is not set in the server environment. ` +
  49  |       `Add it to .env and restart the server.`
  50  |   ).toBe(true);
  51  |   return cfg!;
  52  | }
  53  | 
  54  | /** Navigate the wizard and land on the files view. */
  55  | async function runWizard(page: Page, appName = 'energy_usage_app') {
  56  |   await page.goto('/');
  57  |   await page.waitForLoadState('networkidle');
  58  | 
  59  |   await page.getByText('Create New App').click();
  60  |   await expect(page.getByRole('heading', { name: 'App Details' })).toBeVisible();
  61  | 
  62  |   await page.getByRole('textbox', { name: 'App Name' }).fill(appName);
  63  |   await page.getByRole('textbox', { name: 'Version' }).fill('1.0.0');
  64  | 
  65  |   await page.getByRole('button', { name: 'Next' }).click();
  66  |   await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
  67  |   await page.getByRole('button', { name: 'Next' }).click();
  68  |   await expect(page.getByRole('heading', { name: 'Modular Inputs' })).toBeVisible();
  69  |   await page.getByRole('button', { name: 'Next' }).click();
  70  |   await expect(page.getByRole('heading', { name: 'Review & Generate' })).toBeVisible();
  71  | 
  72  |   await page.getByRole('button', { name: 'Generate App' }).click();
  73  |   await expect(page.getByText('globalConfig.json')).toBeVisible({ timeout: 10_000 });
  74  | }
  75  | 
  76  | /** Open AI Assistant panel and enable auto-accept. */
  77  | async function openAiAndAutoAccept(page: Page) {
  78  |   await page.getByRole('button', { name: 'AI Assistant' }).click();
  79  |   await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 5_000 });
  80  | 
  81  |   await page.getByRole('button', { name: 'Settings' }).click();
  82  |   await expect(page.getByText('AI is server-managed')).toBeVisible({ timeout: 10_000 });
  83  | 
  84  |   const offLabel = page.getByText('You will be prompted to approve file changes.');
  85  |   if (await offLabel.isVisible({ timeout: 1_000 }).catch(() => false)) {
  86  |     await page
  87  |       .getByText('Auto-accept tool actions')
  88  |       .locator('..')
  89  |       .locator('button, [role="switch"]')
  90  |       .first()
  91  |       .click();
  92  |   }
  93  | 
  94  |   await page.getByRole('button', { name: 'Settings' }).click();
  95  |   await expect(page.getByText('AI is server-managed')).not.toBeVisible({ timeout: 5_000 });
  96  | }
  97  | 
  98  | test.describe('AI → Build cycle (Energy API)', () => {
  99  |   test.beforeEach(async ({ page }) => {
  100 |     // 10 min — AI agent + ucc-gen build can take several minutes
  101 |     test.setTimeout(600_000);
  102 |     await page.addInitScript(() => localStorage.clear());
  103 |   });
  104 | 
  105 |   test('AI generates valid Python: no IndentationError refused writes', async ({ page }) => {
  106 |     await requireAi(page);
  107 | 
  108 |     await runWizard(page);
  109 |     await openAiAndAutoAccept(page);
  110 | 
  111 |     const bodyBefore = (await page.locator('body').textContent()) ?? '';
  112 | 
  113 |     await page.locator('textarea').last().fill(ENERGY_PROMPT);
  114 |     await page.getByRole('button', { name: 'Send' }).click();
  115 | 
  116 |     // AI must start within 60 s
  117 |     await expect(page.getByText('Thinking...')).toBeVisible({ timeout: 60_000 });
  118 | 
  119 |     // Wait for AI to finish — "Thinking..." disappears when isLoading goes false
> 120 |     await expect(page.getByText('Thinking...')).not.toBeVisible({ timeout: 540_000 });
      |                                                     ^ Error: expect(locator).not.toBeVisible() failed
  121 | 
  122 |     const bodyAfter = (await page.locator('body').textContent()) ?? '';
  123 | 
  124 |     // AI must have produced content
  125 |     expect(bodyAfter.length - bodyBefore.length).toBeGreaterThan(300);
  126 | 
  127 |     // Core assertions: no security/syntax errors were emitted by the agent
  128 |     expect(bodyAfter).not.toContain('Security Error');
  129 |     expect(bodyAfter).not.toContain('IndentationError');
  130 |     expect(bodyAfter).not.toContain('SyntaxError');
  131 |     expect(bodyAfter).not.toContain('Refused write');
  132 |     expect(bodyAfter).not.toContain('Refused create');
  133 | 
  134 |     // Agent must have mentioned the energy API or written relevant files
  135 |     expect(bodyAfter).toMatch(/energy|getUsage|api[_\-]?key|globalConfig|helper/i);
  136 |   });
  137 | 
  138 |   test('build succeeds after AI generates the energy API input', async ({ page }) => {
  139 |     await requireAi(page);
  140 | 
  141 |     await runWizard(page);
  142 |     await openAiAndAutoAccept(page);
  143 | 
  144 |     // Send prompt and wait for completion
  145 |     await page.locator('textarea').last().fill(ENERGY_PROMPT);
  146 |     await page.getByRole('button', { name: 'Send' }).click();
  147 |     await expect(page.getByText('Thinking...')).toBeVisible({ timeout: 60_000 });
  148 |     await expect(page.getByText('Thinking...')).not.toBeVisible({ timeout: 540_000 });
  149 | 
  150 |     // Close AI panel so build controls are fully accessible
  151 |     await page.getByRole('button', { name: '×' }).click();
  152 |     await expect(page.getByRole('heading', { name: 'AI Assistant' })).not.toBeVisible({ timeout: 5_000 });
  153 | 
  154 |     // Trigger the ucc-gen build
  155 |     await page.getByRole('button', { name: 'Build App' }).click();
  156 |     await expect(page.getByRole('button', { name: 'Building...' })).toBeVisible({ timeout: 10_000 });
  157 | 
  158 |     // Wait for build to finish — "Build App" re-enables when isBuilding goes false (success or failure)
  159 |     await expect(page.getByRole('button', { name: 'Build App' })).toBeEnabled({ timeout: 120_000 });
  160 | 
  161 |     const downloadBtn = page.getByRole('button', { name: 'Download Built App' });
  162 |     const buildLogs = page.locator('pre').last();
  163 |     const logsText = await buildLogs.textContent().catch(() => '');
  164 | 
  165 |     // ucc-gen not installed → skip (separate infrastructure dependency, not a code bug)
  166 |     if (logsText?.includes('ENOENT') || logsText?.includes('ucc-gen not found')) {
  167 |       test.skip(true, 'ucc-gen is not installed in this environment');
  168 |     }
  169 | 
  170 |     await expect(downloadBtn).toBeVisible({ timeout: 5_000 });
  171 |     expect(logsText).not.toContain('IndentationError');
  172 |     expect(logsText).not.toContain('SyntaxError');
  173 |     expect(logsText).not.toContain('Traceback');
  174 |   });
  175 | 
  176 |   test('agent stream endpoint is reachable', async ({ page }) => {
  177 |     const cfg = await getAiConfig(page);
  178 |     expect(cfg, 'Backend is not running on port 3001. Start with: npm run dev:all').not.toBeNull();
  179 | 
  180 |     const res = await page.request.post(`${BACKEND}/api/ai/agent/stream`, {
  181 |       data: {
  182 |         sessionId: 'e2e-tool-check',
  183 |         messages: [{ role: 'user', content: 'list_files' }],
  184 |         files: [],
  185 |         maxIterations: 1,
  186 |         autoValidate: false,
  187 |       },
  188 |       headers: { 'Content-Type': 'application/json' },
  189 |       timeout: 30_000,
  190 |     });
  191 | 
  192 |     // 200 = server-managed, 403 = no key configured — both are valid responses
  193 |     // 500 means the endpoint itself is broken
  194 |     expect(res.status()).not.toBe(500);
  195 |   });
  196 | });
  197 | 
  198 | test.describe('Build wizard cycle (no AI)', () => {
  199 |   test.beforeEach(async ({ page }) => {
  200 |     await page.addInitScript(() => localStorage.clear());
  201 |   });
  202 | 
  203 |   test('Build App button is present after wizard completes', async ({ page }) => {
  204 |     await runWizard(page, 'build_button_test');
  205 |     await expect(page.getByRole('button', { name: 'Build App' })).toBeVisible({ timeout: 5_000 });
  206 |   });
  207 | 
  208 |   test('ucc-gen build runs and reports a result for a minimal app', async ({ page }) => {
  209 |     test.setTimeout(120_000);
  210 | 
  211 |     await runWizard(page, 'minimal_build_test');
  212 |     await page.getByRole('button', { name: 'Build App' }).click();
  213 |     await expect(page.getByRole('button', { name: 'Building...' })).toBeVisible({ timeout: 10_000 });
  214 | 
  215 |     // Wait for build to finish — "Build App" re-enables when isBuilding goes false (success or failure)
  216 |     await expect(page.getByRole('button', { name: 'Build App' })).toBeEnabled({ timeout: 90_000 });
  217 | 
  218 |     const downloadBtn = page.getByRole('button', { name: 'Download Built App' });
  219 |     const logsEl = page.locator('pre').last();
  220 |     const logsText = await logsEl.textContent().catch(() => '');
```