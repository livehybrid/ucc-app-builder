#!/usr/bin/env node
/**
 * Headless Playwright check — used by the agent's `browser_check` tool.
 *
 * Usage:
 *   node server/scripts/browser-check.mjs <url> [expectText1] [expectText2] ...
 *
 * Exits 0 on success, 1 on failure (console errors, missing expected text, or
 * navigation failure). Prints JSON to stdout with `{ ok, consoleErrors,
 * networkErrors, missingTexts }`.
 */

import { chromium } from 'playwright';

const [, , url, ...expectTexts] = process.argv;

if (!url) {
  console.error('usage: browser-check.mjs <url> [expectText ...]');
  process.exit(2);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const consoleErrors = [];
  const networkErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('response', (resp) => {
    if (resp.status() >= 500) networkErrors.push(`${resp.status()} ${resp.url()}`);
  });

  let navOk = true;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000); // let JS settle
  } catch (err) {
    navOk = false;
    networkErrors.push(`goto failed: ${err.message}`);
  }

  const bodyText = navOk ? await page.evaluate(() => document.body.innerText) : '';
  const missingTexts = expectTexts.filter((t) => !bodyText.includes(t));

  await browser.close();

  const ok = navOk && consoleErrors.length === 0 && networkErrors.length === 0 && missingTexts.length === 0;
  process.stdout.write(JSON.stringify({ ok, consoleErrors, networkErrors, missingTexts, navOk }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(err.stack + '\n');
  process.exit(2);
});
