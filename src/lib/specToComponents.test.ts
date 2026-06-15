import { describe, it, expect } from 'vitest';
import { parseSpec, EXAMPLE_SPECS } from './specToComponents';

describe('parseSpec', () => {
  it('derives a TA_ appId and a short, valid input name from a verbose spec', () => {
    const p = parseSpec(
      'Build a Splunk add-on "GitHub Audit" that collects github repository audit events from the GitHub API using an api token for a given org.'
    );
    expect(p.metadata.appId).toBe('TA_github_audit');
    expect(p.components.inputs).toHaveLength(1);
    const name = p.components.inputs[0].name;
    // Must be concise (<= a couple words) and a valid Splunk identifier.
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(name.split('_').length).toBeLessThanOrEqual(3);
  });

  it('adds an encrypted token field when the spec mentions an api token', () => {
    const p = parseSpec('Collect data from an API using an api token.');
    const fields = p.components.inputs[0].entity.map((e) => e.field);
    expect(fields).toContain('api_token');
    const token = p.components.inputs[0].entity.find((e) => e.field === 'api_token');
    expect(token?.type).toBe('password');
    expect(token?.encrypted).toBe(true);
  });

  it('always produces an input-bearing add-on so the loop has real source to validate', () => {
    const p = parseSpec('anything at all');
    expect(p.components.inputs.length).toBeGreaterThan(0);
  });

  it('ships runnable example specs', () => {
    expect(EXAMPLE_SPECS.length).toBeGreaterThan(0);
    for (const ex of EXAMPLE_SPECS) {
      const p = parseSpec(ex.spec);
      expect(p.metadata.appId.startsWith('TA_')).toBe(true);
    }
  });
});
