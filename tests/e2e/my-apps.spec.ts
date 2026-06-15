import { test, expect } from '@playwright/test';

/**
 * "My Apps" — the native-Splunk-only server-side library of saved add-on projects.
 *
 * The feature is gated on `window.__UCC_SPLUNK_FETCH__` (set by the Splunk loader): the
 * "My Apps" button only renders when it exists, and the modal calls /list_apps, /save_app,
 * /load_app, /delete_app through it. We inject a hermetic in-memory mock of that helper
 * via addInitScript (it runs BEFORE the app mounts, so appLibraryAvailable() is true),
 * then drive the modal end-to-end with no backend.
 */
const SPLUNK_FETCH_MOCK = `
window.__E2E_APPS__ = window.__E2E_APPS__ || {};
window.__UCC_SPLUNK_FETCH__ = (path, init) => {
  const store = window.__E2E_APPS__;
  const body = init && init.body ? JSON.parse(init.body) : {};
  const reply = (obj, status) =>
    Promise.resolve(new Response(JSON.stringify(obj), {
      status: status || 200, headers: { 'Content-Type': 'application/json' },
    }));
  if (path === '/list_apps') {
    return reply({ ok: true, apps: Object.values(store).map((a) => ({
      appId: a.appId, name: a.name, version: a.version,
      updated_at: a.updated_at, fileCount: (a._files || []).length,
    })) });
  }
  if (path === '/save_app') {
    store[body.appId] = { appId: body.appId, name: body.name, version: body.version,
      updated_at: Date.now() / 1000, _files: body.files || [] };
    return reply({ ok: true, fileCount: (body.files || []).length });
  }
  if (path === '/load_app') {
    const a = store[body.appId];
    return a ? reply({ ok: true, found: true, appId: a.appId, name: a.name,
      version: a.version, files: a._files || [] }) : reply({ ok: true, found: false });
  }
  if (path === '/delete_app') {
    delete store[body.appId];
    return reply({ ok: true, deleted: body.appId });
  }
  return reply({ ok: true });
};
`;

test('My Apps lists a saved project and can delete it', async ({ page }) => {
  await page.addInitScript(`
    ${SPLUNK_FETCH_MOCK}
    // Pre-seed one saved app so the list is populated on first open.
    window.__E2E_APPS__['ta_seeded'] = {
      appId: 'ta_seeded', name: 'Seeded Add-on', version: '2.1.0',
      updated_at: Date.now() / 1000, _files: [{ path: 'ta_seeded/globalConfig.json', content: '{}' }],
    };
  `);
  await page.goto('/');

  // The gated button renders only because __UCC_SPLUNK_FETCH__ exists.
  const myApps = page.getByRole('button', { name: 'My Apps' });
  await expect(myApps).toBeVisible();
  await myApps.click();

  // Modal opens and lists the seeded app.
  await expect(page.getByRole('heading', { name: 'My Apps' })).toBeVisible();
  await expect(page.getByText('Seeded Add-on')).toBeVisible();
  await expect(page.getByText('ta_seeded')).toBeVisible();

  // Delete removes it -> empty-state copy appears.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/No saved apps yet/)).toBeVisible();
});

test('My Apps saves the current generated app into the library', async ({ page }) => {
  await page.addInitScript(SPLUNK_FETCH_MOCK);
  await page.goto('/');

  // Generate an app so "Save current app" is enabled (gated on `generated`).
  await page.getByRole('button', { name: 'New App' }).click();
  await page.getByPlaceholder('My Splunk App').first().fill('e2e_saveable');
  const next = page.getByRole('button', { name: 'Next' });
  await next.click(); // Branding
  await next.click(); // Components
  await next.click(); // Review
  await page.getByRole('button', { name: 'Generate App' }).click();
  await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeVisible({ timeout: 15_000 });

  // Save it via My Apps.
  await page.getByRole('button', { name: 'My Apps' }).click();
  const dialog = page.getByRole('dialog', { name: 'My Apps' });
  await expect(dialog.getByRole('heading', { name: 'My Apps' })).toBeVisible();
  await dialog.getByRole('button', { name: /Save current app/ }).click();

  // The saved app now appears in the library list (the wizard appId is the sanitised
  // name e2e_saveable — the `ta_` prefix is only added by the MCP create_addon path).
  await expect(dialog.getByText('e2e_saveable', { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(dialog.getByText(/files/)).toBeVisible();
});
