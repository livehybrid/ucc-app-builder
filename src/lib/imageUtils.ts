/**
 * Image utilities for icon resizing
 * Generates all required Splunk icon sizes from a single uploaded image
 */

interface IconSet {
  'appIcon.png': string; // 36x36
  'appIcon_2x.png': string; // 72x72
  'appIconAlt.png': string; // 36x36
  'appIconAlt_2x.png': string; // 72x72
}

export const ICON_SIZES = {
  'appIcon.png': 36,
  'appIcon_2x.png': 72,
  'appIconAlt.png': 36,
  'appIconAlt_2x.png': 72,
} as const;

/**
 * Resize an image to the specified dimensions
 */
function resizeImage(img: HTMLImageElement, targetWidth: number, targetHeight: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not get canvas context');
  }

  // Use high-quality image scaling
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Calculate scaling to fit and center the image
  const scale = Math.min(targetWidth / img.width, targetHeight / img.height);
  const scaledWidth = img.width * scale;
  const scaledHeight = img.height * scale;
  const offsetX = (targetWidth - scaledWidth) / 2;
  const offsetY = (targetHeight - scaledHeight) / 2;

  // Clear canvas with transparent background
  ctx.clearRect(0, 0, targetWidth, targetHeight);

  // Draw the scaled image centered
  ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

  return canvas.toDataURL('image/png');
}

/**
 * Load an image from a File object
 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));

    const reader = new FileReader();
    reader.onload = (e) => {
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Generate all required Splunk icon sizes from a single image file
 */
export async function generateIconSet(file: File): Promise<IconSet> {
  const img = await loadImage(file);

  return {
    'appIcon.png': resizeImage(img, 36, 36),
    'appIcon_2x.png': resizeImage(img, 72, 72),
    'appIconAlt.png': resizeImage(img, 36, 36),
    'appIconAlt_2x.png': resizeImage(img, 72, 72),
  };
}

/**
 * Convert a data URL to binary content for storage
 * Returns the base64 portion without the data URL prefix
 */
export function dataUrlToBase64(dataUrl: string | undefined): string {
  if (!dataUrl) return '';
  const match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
  return match ? match[1] : '';
}

/**
 * Validate that a file is a valid image
 */
export function isValidImageFile(file: File): boolean {
  const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif'];
  return validTypes.includes(file.type);
}
