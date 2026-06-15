import { test, expect } from '@playwright/test';

/**
 * Seed from installed app — load an add-on already installed on this Splunk into the
 * builder. Gated on the loader's __UCC_SPLUNK_FETCH__ helper (/list_installed_apps,
 * /import_installed_app). We inject a hermetic mock of both so the seed panel renders
 * and drives end-to-end: list -> Seed -> analysis -> Import to Editor -> Files view.
 */
const SPLUNK_MOCK = `
window.__UCC_SPLUNK_FETCH__ = (path, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  const reply = (obj, status) =>
    Promise.resolve(new Response(JSON.stringify(obj), {
      status: status || 200, headers: { 'Content-Type': 'application/json' },
    }));
  if (path === '/list_installed_apps') {
    return reply({ ok: true, apps: [
      { appId: 'ta_seeded_inst', displayName: 'Seeded Installed', version: '1.2.3', isUCCApp: true },
    ] });
  }
  if (path === '/import_installed_app') {
    if (body.appId !== 'ta_seeded_inst') return reply({ error: 'app not found' }, 404);
    return reply({ ok: true, appId: 'ta_seeded_inst', truncated: false, skipped: [], files: [
      { path: 'ta_seeded_inst/globalConfig.json',
        content: JSON.stringify({ meta: { name: 'ta_seeded_inst', displayName: 'Seeded Installed', version: '1.2.3' } }) },
      { path: 'ta_seeded_inst/default/props.conf', content: '[seeded:st]\\nSHOULD_LINEMERGE = false\\n' },
      { path: 'ta_seeded_inst/bin/seeded.py', content: 'print(1)\\n' },
    ] });
  }
  return reply({ ok: true });
};
`;

test('Seed from installed app loads its source into the editor', async ({ page }) => {
  await page.addInitScript(SPLUNK_MOCK);
  await page.goto('/');

  // Go to the Import view; the seed panel renders because __UCC_SPLUNK_FETCH__ exists.
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Seed from an add-on installed on this Splunk')).toBeVisible();
  await expect(page.getByText('Seeded Installed')).toBeVisible();

  // Seed it -> the same analysis UI the ZIP path produces.
  await page.getByRole('button', { name: 'Seed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Analysis Results' })).toBeVisible();
  const importBtn = page.getByRole('button', { name: 'Import to Editor' });
  await expect(importBtn).toBeVisible();

  // Load into the builder -> switches to the Files view (Download ZIP available).
  await importBtn.click();
  await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeVisible({ timeout: 15_000 });
});
