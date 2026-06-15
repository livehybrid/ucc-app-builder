import { describe, it, expect } from 'vitest';
import { runValidator, validateField, validateRequired } from './validators';

describe('runValidator', () => {
  // --- string validator ---
  describe('string validator', () => {
    it('should pass when no length constraints', () => {
      expect(runValidator('hello', { type: 'string' })).toEqual({ valid: true });
    });

    it('should fail when value is shorter than minLength', () => {
      const result = runValidator('ab', { type: 'string', minLength: 3 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Minimum length');
    });

    it('should fail when value exceeds maxLength', () => {
      const result = runValidator('abcdef', { type: 'string', maxLength: 3 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Maximum length');
    });

    it('should pass when within length bounds', () => {
      expect(runValidator('abc', { type: 'string', minLength: 2, maxLength: 5 })).toEqual({
        valid: true,
      });
    });

    it('should use custom error message when provided', () => {
      const result = runValidator('a', { type: 'string', minLength: 5, errorMsg: 'Too short!' });
      expect(result.error).toBe('Too short!');
    });
  });

  // --- number validator ---
  describe('number validator', () => {
    it('should pass for valid numbers', () => {
      expect(runValidator('42', { type: 'number' })).toEqual({ valid: true });
    });

    it('should fail for non-numeric input', () => {
      const result = runValidator('abc', { type: 'number' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('valid number');
    });

    it('should fail when below min', () => {
      const result = runValidator('3', { type: 'number', min: 5 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Minimum value');
    });

    it('should fail when above max', () => {
      const result = runValidator('100', { type: 'number', max: 50 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Maximum value');
    });

    it('should pass when within range', () => {
      expect(runValidator('10', { type: 'number', min: 1, max: 100 })).toEqual({ valid: true });
    });
  });

  // --- regex validator ---
  describe('regex validator', () => {
    it('should pass when no pattern specified', () => {
      expect(runValidator('anything', { type: 'regex' })).toEqual({ valid: true });
    });

    it('should pass when value matches pattern', () => {
      expect(runValidator('abc123', { type: 'regex', pattern: '^[a-z0-9]+$' })).toEqual({
        valid: true,
      });
    });

    it('should fail when value does not match pattern', () => {
      const result = runValidator('ABC!', { type: 'regex', pattern: '^[a-z]+$' });
      expect(result.valid).toBe(false);
    });

    it('should fail gracefully for invalid regex pattern', () => {
      const result = runValidator('test', { type: 'regex', pattern: '[invalid' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid regex');
    });
  });

  // --- url validator ---
  describe('url validator', () => {
    it('should pass for valid http URL', () => {
      expect(runValidator('http://example.com', { type: 'url' })).toEqual({ valid: true });
    });

    it('should pass for valid https URL', () => {
      expect(runValidator('https://example.com/path', { type: 'url' })).toEqual({ valid: true });
    });

    it('should fail for invalid URL', () => {
      const result = runValidator('not-a-url', { type: 'url' });
      expect(result.valid).toBe(false);
    });

    it('should pass for empty value', () => {
      expect(runValidator('', { type: 'url' })).toEqual({ valid: true });
    });
  });

  // --- email validator ---
  describe('email validator', () => {
    it('should pass for valid email', () => {
      expect(runValidator('user@example.com', { type: 'email' })).toEqual({ valid: true });
    });

    it('should fail for invalid email', () => {
      const result = runValidator('not-an-email', { type: 'email' });
      expect(result.valid).toBe(false);
    });

    it('should pass for empty value', () => {
      expect(runValidator('', { type: 'email' })).toEqual({ valid: true });
    });
  });

  // --- ipv4 validator ---
  describe('ipv4 validator', () => {
    it('should pass for valid IPv4', () => {
      expect(runValidator('192.168.1.1', { type: 'ipv4' })).toEqual({ valid: true });
    });

    it('should fail for invalid format', () => {
      const result = runValidator('999.999.999.999', { type: 'ipv4' });
      expect(result.valid).toBe(false);
    });

    it('should fail for octet > 255', () => {
      const result = runValidator('192.168.1.256', { type: 'ipv4' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('octets');
    });

    it('should fail for non-IP string', () => {
      const result = runValidator('not-an-ip', { type: 'ipv4' });
      expect(result.valid).toBe(false);
    });

    it('should pass for empty value', () => {
      expect(runValidator('', { type: 'ipv4' })).toEqual({ valid: true });
    });
  });

  // --- date validator ---
  describe('date validator', () => {
    it('should pass for valid date', () => {
      expect(runValidator('2024-01-15', { type: 'date' })).toEqual({ valid: true });
    });

    it('should fail for invalid date format', () => {
      const result = runValidator('01/15/2024', { type: 'date' });
      expect(result.valid).toBe(false);
    });

    it('should pass for empty value', () => {
      expect(runValidator('', { type: 'date' })).toEqual({ valid: true });
    });
  });

  // --- unknown type ---
  it('should pass for unknown validator type', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(runValidator('anything', { type: 'custom' as any })).toEqual({ valid: true });
  });
});

describe('validateField', () => {
  it('should pass when all validators pass', () => {
    const result = validateField('hello', [
      { type: 'string', minLength: 1 },
      { type: 'string', maxLength: 10 },
    ]);
    expect(result).toEqual({ valid: true });
  });

  it('should fail on first failing validator', () => {
    const result = validateField('a', [
      { type: 'string', minLength: 5 },
      { type: 'string', maxLength: 10 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Minimum length');
  });

  it('should pass with empty validators array', () => {
    expect(validateField('anything', [])).toEqual({ valid: true });
  });
});

describe('validateRequired', () => {
  it('should fail when required and value is empty', () => {
    const result = validateRequired('', true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should fail when required and value is undefined', () => {
    expect(validateRequired(undefined, true).valid).toBe(false);
  });

  it('should fail when required and value is null', () => {
    expect(validateRequired(null, true).valid).toBe(false);
  });

  it('should fail when required and value is whitespace only', () => {
    expect(validateRequired('   ', true).valid).toBe(false);
  });

  it('should pass when required and value is present', () => {
    expect(validateRequired('hello', true)).toEqual({ valid: true });
  });

  it('should pass when not required regardless of value', () => {
    expect(validateRequired('', false)).toEqual({ valid: true });
    expect(validateRequired(undefined, false)).toEqual({ valid: true });
    expect(validateRequired(null, false)).toEqual({ valid: true });
  });
});
