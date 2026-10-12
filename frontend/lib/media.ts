/**
 * Client-side image compression for future technician photos (V0.2 utility).
 *
 * Low-data targets: approximately 800px maximum dimension and approximately
 * 150KB output. Returns null on any failure (non-image input, unsupported
 * browser APIs, unreadable file) so callers can degrade gracefully. Storage
 * quota handling belongs to lib/mocks/persistence.ts.
 */
export interface ImageCompressionLimits {
  maxDimension: number;
  maxSizeBytes: number;
}

export const TECHNICIAN_PHOTO_LIMITS: ImageCompressionLimits = {
  maxDimension: 800,
  maxSizeBytes: 150 * 1024,
};

export async function compressTechnicianPhoto(
  file: File,
  limits: ImageCompressionLimits = TECHNICIAN_PHOTO_LIMITS,
): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  if (!file.type.startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, limits.maxDimension / Math.max(bitmap.width, bitmap.height));
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    // Try progressively lower qualities until the size target is met.
    for (const quality of [0.82, 0.65, 0.45]) {
      const blob = await renderJpeg(canvas, quality);
      if (blob !== null && blob.size <= limits.maxSizeBytes) return blob;
    }
    // Best effort: return the smallest attempt and let the caller decide.
    return renderJpeg(canvas, 0.3);
  } catch {
    return null;
  }
}

function renderJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });
}
