/**
 * Validation engine for UCC entity validators
 * Runs validators against field values and returns error messages
 */

import type { EntityValidator, ValidatorType } from '../types/components';

interface ValidationResult {
  valid: boolean;
  error?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_REGEX = /^https?:\/\/[^\s]+$/;
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a single value against a single validator
 */
export function runValidator(value: string, validator: EntityValidator): ValidationResult {
  const defaultError = (msg: string) => validator.errorMsg || msg;

  switch (validator.type as ValidatorType) {
    case 'string': {
      if (validator.minLength !== undefined && value.length < validator.minLength) {
        return {
          valid: false,
          error: defaultError(`Minimum length is ${validator.minLength} characters`),
        };
      }
      if (validator.maxLength !== undefined && value.length > validator.maxLength) {
        return {
          valid: false,
          error: defaultError(`Maximum length is ${validator.maxLength} characters`),
        };
      }
      return { valid: true };
    }

    case 'number': {
      const num = Number(value);
      if (isNaN(num)) {
        return { valid: false, error: defaultError('Must be a valid number') };
      }
      if (validator.min !== undefined && num < validator.min) {
        return { valid: false, error: defaultError(`Minimum value is ${validator.min}`) };
      }
      if (validator.max !== undefined && num > validator.max) {
        return { valid: false, error: defaultError(`Maximum value is ${validator.max}`) };
      }
      return { valid: true };
    }

    case 'regex': {
      if (!validator.pattern) return { valid: true };
      try {
        const regex = new RegExp(validator.pattern);
        if (!regex.test(value)) {
          return { valid: false, error: defaultError(`Does not match required pattern`) };
        }
      } catch {
        return { valid: false, error: 'Invalid regex pattern configured' };
      }
      return { valid: true };
    }

    case 'url': {
      if (value && !URL_REGEX.test(value)) {
        return { valid: false, error: defaultError('Must be a valid URL (http:// or https://)') };
      }
      return { valid: true };
    }

    case 'email': {
      if (value && !EMAIL_REGEX.test(value)) {
        return { valid: false, error: defaultError('Must be a valid email address') };
      }
      return { valid: true };
    }

    case 'ipv4': {
      if (value && !IPV4_REGEX.test(value)) {
        return { valid: false, error: defaultError('Must be a valid IPv4 address') };
      }
      if (value) {
        const octets = value.split('.').map(Number);
        if (octets.some((o) => o < 0 || o > 255)) {
          return { valid: false, error: defaultError('IPv4 octets must be 0-255') };
        }
      }
      return { valid: true };
    }

    case 'date': {
      if (value && !DATE_REGEX.test(value)) {
        return { valid: false, error: defaultError('Must be a valid date (YYYY-MM-DD)') };
      }
      return { valid: true };
    }

    default:
      return { valid: true };
  }
}

/**
 * Validate a value against all validators for a field
 */
export function validateField(value: string, validators: EntityValidator[]): ValidationResult {
  for (const validator of validators) {
    const result = runValidator(value, validator);
    if (!result.valid) return result;
  }
  return { valid: true };
}

/**
 * Validate required field
 */
export function validateRequired(
  value: string | undefined | null,
  required: boolean
): ValidationResult {
  if (required && (!value || value.trim() === '')) {
    return { valid: false, error: 'This field is required' };
  }
  return { valid: true };
}
