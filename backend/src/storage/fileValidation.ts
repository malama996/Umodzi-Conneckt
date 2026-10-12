/**
 * Validate file buffer magic bytes against expected MIME types.
 *
 * Checks file signatures (magic numbers) to prevent file extension spoofing
 * and reject executables/scripts disguised as images or PDFs.
 */

export interface MagicByteValidationResult {
  valid: boolean;
  detectedMime?: string;
  error?: string;
}

export function validateMagicBytes(buffer: Buffer, expectedMime: string): MagicByteValidationResult {
  if (!buffer || buffer.length < 4) {
    return { valid: false, error: 'File buffer too small or empty' };
  }

  // Check for JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    if (expectedMime === 'image/jpeg') {
      return { valid: true, detectedMime: 'image/jpeg' };
    }
    return { valid: false, detectedMime: 'image/jpeg', error: `Expected ${expectedMime} but detected image/jpeg` };
  }

  // Check for PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    if (expectedMime === 'image/png') {
      return { valid: true, detectedMime: 'image/png' };
    }
    return { valid: false, detectedMime: 'image/png', error: `Expected ${expectedMime} but detected image/png` };
  }

  // Check for WebP: RIFF ... WEBP (52 49 46 46 .... 57 45 42 50)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    if (expectedMime === 'image/webp') {
      return { valid: true, detectedMime: 'image/webp' };
    }
    return { valid: false, detectedMime: 'image/webp', error: `Expected ${expectedMime} but detected image/webp` };
  }

  // Check for PDF: %PDF- (25 50 44 46 2D)
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    if (expectedMime === 'application/pdf') {
      return { valid: true, detectedMime: 'application/pdf' };
    }
    return { valid: false, detectedMime: 'application/pdf', error: `Expected ${expectedMime} but detected application/pdf` };
  }

  // Reject executables / dangerous formats explicitly
  // Windows PE: MZ (4D 5A)
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return { valid: false, error: 'Executable files are strictly rejected' };
  }
  // ELF: 7F 45 4C 46
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    return { valid: false, error: 'Executable files are strictly rejected' };
  }
  // Script / HTML / XML starting with <
  if (buffer[0] === 0x3c) {
    return { valid: false, error: 'Script or markup files are strictly rejected' };
  }

  return { valid: false, error: 'File content does not match allowed signatures (JPEG, PNG, WebP, PDF)' };
}
