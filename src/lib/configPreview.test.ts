import { describe, it, expect } from 'vitest';
import { buildPreviewModel, validateEntityValue, initialValues } from './configPreview';
import type { PreviewEntity } from './configPreview';

const SAMPLE = JSON.stringify({
  meta: { name: 'my_addon', displayName: 'My Add-on', version: '1.0.0', restRoot: 'my_addon' },
  pages: {
    configuration: {
      title: 'Configuration',
      tabs: [
        {
          name: 'account',
          title: 'Account',
          table: { header: [{ label: 'Name', field: 'name' }] },
          entity: [
            { type: 'text', field: 'name', label: 'Name', required: true },
            {
              type: 'text',
              field: 'api_key',
              label: 'API Key',
              encrypted: true,
              validators: [{ type: 'string', minLength: 10, maxLength: 64 }],
            },
          ],
        },
        { type: 'loggingTab' },
        { type: 'proxyTab' },
      ],
    },
    inputs: {
      title: 'Inputs',
      services: [
        {
          name: 'my_input',
          title: 'My Input',
          entity: [
            { type: 'text', field: 'name', label: 'Name', required: true },
            { type: 'interval', field: 'interval', label: 'Interval', defaultValue: '300' },
            { type: 'index', field: 'index', label: 'Index' },
          ],
        },
      ],
    },
  },
  alerts: [
    {
      name: 'my_alert',
      label: 'My Alert',
      entity: [{ type: 'text', field: 'url', label: 'URL', validators: [{ type: 'url' }] }],
    },
  ],
});

describe('buildPreviewModel', () => {
  it('parses meta, tabs, services and alerts', () => {
    const m = buildPreviewModel(SAMPLE);
    expect(m.meta.displayName).toBe('My Add-on');
    expect(m.configurationTabs.map((t) => t.name)).toEqual(['account', 'logging', 'proxy']);
    expect(m.inputServices).toHaveLength(1);
    expect(m.alerts).toHaveLength(1);
  });

  it('expands loggingTab and proxyTab shorthand into entities', () => {
    const m = buildPreviewModel(SAMPLE);
    const logging = m.configurationTabs.find((t) => t.name === 'logging')!;
    expect(logging.entity[0].field).toBe('loglevel');
    const proxy = m.configurationTabs.find((t) => t.name === 'proxy')!;
    expect(proxy.entity.some((e) => e.field === 'proxy_port')).toBe(true);
  });

  it('keeps account table headers', () => {
    const m = buildPreviewModel(SAMPLE);
    expect(m.configurationTabs[0].table?.header[0].field).toBe('name');
  });

  it('throws a readable error on malformed JSON', () => {
    expect(() => buildPreviewModel('{ nope')).toThrow(/not valid JSON/);
  });

  it('exposes nav flags: pages present vs absent', () => {
    const full = buildPreviewModel(SAMPLE);
    expect(full.hasInputsPage).toBe(true);
    expect(full.hasConfigurationPage).toBe(true);

    // No configuration tabs / no inputs page → nav must not offer those views.
    const bare = buildPreviewModel(
      JSON.stringify({ meta: { name: 'TA_x', displayName: 'X' }, pages: {} })
    );
    expect(bare.hasInputsPage).toBe(false);
    expect(bare.hasConfigurationPage).toBe(false);
    expect(bare.hasDashboard).toBe(false);
  });
});

describe('validateEntityValue', () => {
  const text = (over: Partial<PreviewEntity>): PreviewEntity => ({
    type: 'text',
    field: 'f',
    label: 'F',
    ...over,
  });

  it('flags required empty values, accepts optional empties', () => {
    expect(validateEntityValue(text({ required: true }), '')).toMatch(/required/);
    expect(validateEntityValue(text({}), '')).toBeNull();
  });

  it('enforces string length validators', () => {
    const e = text({ validators: [{ type: 'string', minLength: 3, maxLength: 5 }] });
    expect(validateEntityValue(e, 'ab')).toMatch(/greater than/);
    expect(validateEntityValue(e, 'abcdef')).toMatch(/less than/);
    expect(validateEntityValue(e, 'abcd')).toBeNull();
  });

  it('enforces regex validators and prefers custom errorMsg', () => {
    const e = text({
      validators: [{ type: 'regex', pattern: '^[a-z]+$', errorMsg: 'lowercase only' }],
    });
    expect(validateEntityValue(e, 'ABC')).toBe('lowercase only');
    expect(validateEntityValue(e, 'abc')).toBeNull();
  });

  it('enforces number range + integer validators', () => {
    const e = text({ validators: [{ type: 'number', range: [1, 65535], isInteger: true }] });
    expect(validateEntityValue(e, 'nope')).toMatch(/not a number/);
    expect(validateEntityValue(e, '1.5')).toMatch(/not an integer/);
    expect(validateEntityValue(e, '70000')).toMatch(/range/);
    expect(validateEntityValue(e, '8089')).toBeNull();
  });

  it('validates url, email, ipv4, date', () => {
    expect(
      validateEntityValue(text({ validators: [{ type: 'url' }] }), 'https://x.com')
    ).toBeNull();
    expect(validateEntityValue(text({ validators: [{ type: 'url' }] }), 'ht tp://x')).toMatch(
      /URL/
    );
    expect(validateEntityValue(text({ validators: [{ type: 'email' }] }), 'a@b.co')).toBeNull();
    expect(validateEntityValue(text({ validators: [{ type: 'email' }] }), 'nope')).toMatch(/email/);
    expect(validateEntityValue(text({ validators: [{ type: 'ipv4' }] }), '10.0.0.1')).toBeNull();
    expect(validateEntityValue(text({ validators: [{ type: 'ipv4' }] }), '999.1.1.1')).toMatch(
      /IPV4/
    );
    expect(validateEntityValue(text({ validators: [{ type: 'date' }] }), '2026-06-10')).toBeNull();
    expect(validateEntityValue(text({ validators: [{ type: 'date' }] }), 'not-a-date')).toMatch(
      /date/
    );
  });

  it('validates interval entities as seconds or cron', () => {
    const e: PreviewEntity = { type: 'interval', field: 'interval', label: 'Interval' };
    expect(validateEntityValue(e, '300')).toBeNull();
    expect(validateEntityValue(e, '*/5 * * * *')).toBeNull();
    expect(validateEntityValue(e, 'often')).toMatch(/seconds or a cron/);
  });
});

describe('initialValues', () => {
  it('seeds defaults and unchecked checkboxes', () => {
    const vals = initialValues([
      { type: 'text', field: 'a', label: 'A', defaultValue: 'x' },
      { type: 'checkbox', field: 'b', label: 'B' },
      { type: 'text', field: 'c', label: 'C' },
    ]);
    expect(vals).toEqual({ a: 'x', b: false });
  });
});
