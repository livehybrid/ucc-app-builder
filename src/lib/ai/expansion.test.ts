import { describe, it, expect } from 'vitest';
import {
  parseSpec,
  renderBuildInstruction,
  specWarnings,
  expansionUserPrompt,
  type UccSpec,
} from './expansion';

const GOOD = JSON.stringify({
  appId: 'TA_acme_logs',
  name: 'Acme Logs Add-on',
  description: 'Collects Acme API usage.',
  vendor: 'Acme',
  defaultIndex: 'main',
  account: {
    authType: 'api_key',
    multipleAccounts: true,
    fields: [{ name: 'api_key', label: 'API Key', type: 'password', required: true, encrypted: true }],
  },
  proxy: true,
  loggingLevel: true,
  sslVerify: true,
  inputs: [
    {
      name: 'api_usage',
      label: 'API Usage',
      collection: 'rest_api',
      endpoint: 'https://api.acme.com/v1/usage',
      method: 'GET',
      interval: 300,
      sourcetype: 'acme:api:usage',
      index: 'main',
      checkpoint: true,
      cim: 'Web',
      fields: [{ name: 'start_date', type: 'text' }],
    },
  ],
  questions: ['Is usage increasing?'],
  gaps: ['No owner lookup in source'],
  grounded: false,
});

describe('parseSpec', () => {
  it('parses a well-formed spec', () => {
    const s = parseSpec(GOOD);
    expect(s.appId).toBe('TA_acme_logs');
    expect(s.account.authType).toBe('api_key');
    expect(s.account.fields[0].encrypted).toBe(true);
    expect(s.inputs).toHaveLength(1);
    expect(s.inputs[0].interval).toBe(300);
    expect(s.inputs[0].cim).toBe('Web');
  });

  it('extracts JSON from markdown fences and surrounding prose', () => {
    const wrapped = 'Sure, here is the spec:\n```json\n' + GOOD + '\n```\nHope that helps!';
    const s = parseSpec(wrapped);
    expect(s.appId).toBe('TA_acme_logs');
  });

  it('marks password fields encrypted even if the model omits the flag', () => {
    const raw = JSON.stringify({
      appId: 'TA_x',
      name: 'X',
      account: { authType: 'basic', fields: [{ name: 'password', type: 'password' }] },
      inputs: [],
    });
    expect(parseSpec(raw).account.fields[0].encrypted).toBe(true);
  });

  it('coerces an invalid auth type and collection to safe defaults', () => {
    const raw = JSON.stringify({
      appId: 'TA_x',
      name: 'X',
      account: { authType: 'magic', fields: [] },
      inputs: [{ name: 'i1', collection: 'telepathy', fields: [] }],
    });
    const s = parseSpec(raw);
    expect(s.account.authType).toBe('none');
    expect(s.inputs[0].collection).toBe('rest_api');
  });

  it('drops malformed fields/inputs without a name', () => {
    const raw = JSON.stringify({
      appId: 'TA_x',
      name: 'X',
      account: { authType: 'none', fields: [{ type: 'text' }, { name: 'ok', type: 'text' }] },
      inputs: [{ collection: 'rest_api', fields: [] }, { name: 'good', fields: [] }],
    });
    const s = parseSpec(raw);
    expect(s.account.fields.map((f) => f.name)).toEqual(['ok']);
    expect(s.inputs.map((i) => i.name)).toEqual(['good']);
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseSpec('no json here')).toThrow(/no JSON/i);
  });
});

describe('specWarnings', () => {
  it('is empty for a complete spec', () => {
    expect(specWarnings(parseSpec(GOOD))).toEqual([]);
  });

  it('flags missing inputs, sourcetype, endpoint, and unencrypted secrets', () => {
    const spec: UccSpec = {
      appId: 'TA_x',
      name: 'X',
      account: { authType: 'api_key', fields: [{ name: 'api_key', type: 'text' }] },
      proxy: false,
      loggingLevel: false,
      inputs: [{ name: 'i1', collection: 'rest_api', fields: [] }],
    };
    const w = specWarnings(spec);
    expect(w.join(' ')).toMatch(/sourcetype/i);
    expect(w.join(' ')).toMatch(/endpoint/i);
    expect(w.join(' ')).toMatch(/encrypted/i);
  });
});

describe('renderBuildInstruction', () => {
  it('embeds the JSON and a prose checklist the agent can follow', () => {
    const instr = renderBuildInstruction(parseSpec(GOOD));
    expect(instr).toMatch(/TA_acme_logs/);
    expect(instr).toMatch(/auth type "api_key"/);
    expect(instr).toMatch(/api_usage/);
    expect(instr).toMatch(/sourcetype acme:api:usage/);
    expect(instr).toMatch(/CIM Web/);
    expect(instr).toMatch(/APPROVED SPEC \(JSON\)/);
    // The raw JSON round-trips inside the instruction.
    const json = instr.slice(instr.indexOf('{'));
    expect(JSON.parse(json).appId).toBe('TA_acme_logs');
  });
});

describe('expansionUserPrompt', () => {
  it('includes grounding when provided and flags absence otherwise', () => {
    expect(expansionUserPrompt('build x', { indexes: ['web', 'main'] })).toMatch(/AVAILABLE INDEXES: web, main/);
    expect(expansionUserPrompt('build x')).toMatch(/not grounded|No live Splunk/i);
  });
});
