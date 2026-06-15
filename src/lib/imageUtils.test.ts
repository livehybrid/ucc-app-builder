import { describe, it, expect } from 'vitest';
import { dataUrlToBase64, isValidImageFile, ICON_SIZES } from './imageUtils';

describe('ICON_SIZES', () => {
  it('should define 4 icon sizes', () => {
    expect(Object.keys(ICON_SIZES)).toHaveLength(4);
  });

  it('should have correct dimensions', () => {
    expect(ICON_SIZES['appIcon.png']).toBe(36);
    expect(ICON_SIZES['appIcon_2x.png']).toBe(72);
    expect(ICON_SIZES['appIconAlt.png']).toBe(36);
    expect(ICON_SIZES['appIconAlt_2x.png']).toBe(72);
  });
});

describe('dataUrlToBase64', () => {
  it('should extract base64 from data URL', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    expect(dataUrlToBase64(dataUrl)).toBe('iVBORw0KGgoAAAANSUhEUg==');
  });

  it('should return empty string for undefined', () => {
    expect(dataUrlToBase64(undefined)).toBe('');
  });

  it('should return empty string for empty string', () => {
    expect(dataUrlToBase64('')).toBe('');
  });

  it('should return empty string for non-data-url string', () => {
    expect(dataUrlToBase64('not a data url')).toBe('');
  });

  it('should handle jpeg data URLs', () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    expect(dataUrlToBase64(dataUrl)).toBe('/9j/4AAQSkZJRg==');
  });
});

describe('isValidImageFile', () => {
  it('should accept PNG files', () => {
    const file = new File([''], 'test.png', { type: 'image/png' });
    expect(isValidImageFile(file)).toBe(true);
  });

  it('should accept JPEG files', () => {
    const file = new File([''], 'test.jpg', { type: 'image/jpeg' });
    expect(isValidImageFile(file)).toBe(true);
  });

  it('should accept SVG files', () => {
    const file = new File([''], 'test.svg', { type: 'image/svg+xml' });
    expect(isValidImageFile(file)).toBe(true);
  });

  it('should accept GIF files', () => {
    const file = new File([''], 'test.gif', { type: 'image/gif' });
    expect(isValidImageFile(file)).toBe(true);
  });

  it('should reject text files', () => {
    const file = new File([''], 'test.txt', { type: 'text/plain' });
    expect(isValidImageFile(file)).toBe(false);
  });

  it('should reject PDF files', () => {
    const file = new File([''], 'test.pdf', { type: 'application/pdf' });
    expect(isValidImageFile(file)).toBe(false);
  });

  it('should reject WebP files (not in allowed list)', () => {
    const file = new File([''], 'test.webp', { type: 'image/webp' });
    expect(isValidImageFile(file)).toBe(false);
  });
});
