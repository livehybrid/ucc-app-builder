import { describe, it, expect } from 'vitest';
import { SPLUNK_SPECS, getAvailableSpecs, hasSpec } from './splunkSpecs';

describe('SPLUNK_SPECS', () => {
  it('should be an object', () => {
    expect(typeof SPLUNK_SPECS).toBe('object');
  });
});

describe('getAvailableSpecs', () => {
  it('should return an array', () => {
    const specs = getAvailableSpecs();
    expect(Array.isArray(specs)).toBe(true);
  });

  it('should return sorted list', () => {
    const specs = getAvailableSpecs();
    const sorted = [...specs].sort();
    expect(specs).toEqual(sorted);
  });
});

describe('hasSpec', () => {
  it('should return false for non-existent spec', () => {
    expect(hasSpec('definitely-not-a-spec.conf')).toBe(false);
  });

  it('should return boolean', () => {
    expect(typeof hasSpec('something.conf')).toBe('boolean');
  });
});
