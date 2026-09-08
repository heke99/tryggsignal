export const BRANDING_ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const BRANDING_ASSET_MAX_DIMENSION = 4096;

export type BrandingAssetKind = 'LOGO' | 'LOGO_DARK' | 'FAVICON';

export interface BrandingImageInfo {
  readonly mimeType: 'image/png' | 'image/webp';
  readonly extension: 'png' | 'webp';
  readonly width: number;
  readonly height: number;
}

export class InvalidBrandingAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBrandingAssetError';
  }
}

function ensureDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > BRANDING_ASSET_MAX_DIMENSION ||
    height > BRANDING_ASSET_MAX_DIMENSION
  ) {
    throw new InvalidBrandingAssetError(
      `Brand asset dimensions must be between 1 and ${BRANDING_ASSET_MAX_DIMENSION}px.`,
    );
  }
}

function inspectPng(bytes: Uint8Array): BrandingImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    return null;
  }

  // A valid PNG starts with an IHDR chunk whose width/height are big-endian.
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    throw new InvalidBrandingAssetError('PNG is missing its IHDR header.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  ensureDimensions(width, height);
  return { mimeType: 'image/png', extension: 'png', width, height };
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function inspectWebp(bytes: Uint8Array): BrandingImageInfo | null {
  if (bytes.length < 30) return null;
  const ascii = (start: number, text: string): boolean =>
    [...text].every((value, index) => bytes[start + index] === value.charCodeAt(0));

  if (!ascii(0, 'RIFF') || !ascii(8, 'WEBP')) return null;

  let width: number;
  let height: number;

  if (ascii(12, 'VP8X')) {
    width = uint24le(bytes, 24) + 1;
    height = uint24le(bytes, 27) + 1;
  } else if (ascii(12, 'VP8L')) {
    if (bytes[20] !== 0x2f || bytes.length < 25) {
      throw new InvalidBrandingAssetError('WebP lossless header is invalid.');
    }
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    width = 1 + (b1 | ((b2 & 0x3f) << 8));
    height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
  } else if (ascii(12, 'VP8 ')) {
    if (
      bytes.length < 30 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      throw new InvalidBrandingAssetError('WebP lossy frame header is invalid.');
    }
    width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
  } else {
    throw new InvalidBrandingAssetError('Unsupported WebP encoding.');
  }

  ensureDimensions(width, height);
  return { mimeType: 'image/webp', extension: 'webp', width, height };
}

/**
 * Validates the bytes rather than trusting a browser-supplied MIME type or
 * filename. SVG is intentionally unsupported because tenant-controlled active
 * markup has no place in the shared white-label surface.
 */
export function inspectBrandingImage(bytes: Uint8Array): BrandingImageInfo {
  if (bytes.length === 0 || bytes.length > BRANDING_ASSET_MAX_BYTES) {
    throw new InvalidBrandingAssetError(
      `Brand assets must be between 1 byte and ${BRANDING_ASSET_MAX_BYTES} bytes.`,
    );
  }

  const png = inspectPng(bytes);
  if (png !== null) return png;

  const webp = inspectWebp(bytes);
  if (webp !== null) return webp;

  throw new InvalidBrandingAssetError(
    'Only genuine PNG or WebP image bytes are accepted.',
  );
}
