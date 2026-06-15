import { describe, it, expect } from 'vitest';
import { TEMPLATE_CATEGORIES, DIFFICULTY_INFO } from './templates';

describe('TEMPLATE_CATEGORIES', () => {
  it('should define all 7 categories', () => {
    expect(TEMPLATE_CATEGORIES).toHaveLength(7);
  });

  it('should have expected category IDs', () => {
    const ids = TEMPLATE_CATEGORIES.map((c) => c.id);
    expect(ids).toContain('rest-api');
    expect(ids).toContain('database');
    expect(ids).toContain('cloud');
    expect(ids).toContain('file-system');
    expect(ids).toContain('webhook');
    expect(ids).toContain('protocol');
    expect(ids).toContain('custom');
  });

  it('should have labels and icons for all categories', () => {
    TEMPLATE_CATEGORIES.forEach((cat) => {
      expect(cat.label).toBeTruthy();
      expect(cat.icon).toBeTruthy();
    });
  });
});

describe('DIFFICULTY_INFO', () => {
  it('should have all difficulty levels', () => {
    expect(DIFFICULTY_INFO.beginner).toBeDefined();
    expect(DIFFICULTY_INFO.intermediate).toBeDefined();
    expect(DIFFICULTY_INFO.advanced).toBeDefined();
  });

  it('should have increasing star counts', () => {
    expect(DIFFICULTY_INFO.beginner.stars).toBe(1);
    expect(DIFFICULTY_INFO.intermediate.stars).toBe(2);
    expect(DIFFICULTY_INFO.advanced.stars).toBe(3);
  });

  it('should have labels', () => {
    expect(DIFFICULTY_INFO.beginner.label).toBe('Beginner');
    expect(DIFFICULTY_INFO.intermediate.label).toBe('Intermediate');
    expect(DIFFICULTY_INFO.advanced.label).toBe('Advanced');
  });
});
