import { describe, expect, it } from 'vitest';
import { searchSplunkSdkReference } from './splunkSdkReference';

describe('splunkSdkReference', () => {
  it('finds Script symbol', () => {
    const results = searchSplunkSdkReference('Script', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.symbol === 'Script')).toBe(true);
  });

  it('finds entries by module query', () => {
    const results = searchSplunkSdkReference('searchcommands', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.module.includes('searchcommands'))).toBe(true);
  });
});
