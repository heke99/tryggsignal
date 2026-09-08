import { describe, expect, it } from 'vitest';
import {
  BRANDING_ASSET_MAX_BYTES,
  InvalidBrandingAssetError,
  inspectBrandingImage,
} from '@tryggsignal/tenancy';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([...Buffer.from('RIFF')], 0);
  bytes.set([...Buffer.from('WEBP')], 8);
  bytes.set([...Buffer.from('VP8X')], 12);
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

describe('branding asset inspection (masterplan 153/164)', () => {
  it('reads PNG dimensions from bytes', () => {
    expect(inspectBrandingImage(png(512, 128))).toEqual({
      mimeType: 'image/png',
      extension: 'png',
      width: 512,
      height: 128,
    });
  });

  it('reads WebP VP8X dimensions from bytes', () => {
    expect(inspectBrandingImage(webpVp8x(640, 320))).toEqual({
      mimeType: 'image/webp',
      extension: 'webp',
      width: 640,
      height: 320,
    });
  });

  it('rejects SVG or arbitrary bytes even when a caller could label them as an image', () => {
    expect(() => inspectBrandingImage(new TextEncoder().encode('<svg><script/></svg>'))).toThrow(
      InvalidBrandingAssetError,
    );
  });

  it('rejects oversized files before any storage upload', () => {
    expect(() => inspectBrandingImage(new Uint8Array(BRANDING_ASSET_MAX_BYTES + 1))).toThrow(
      InvalidBrandingAssetError,
    );
  });

  it('rejects decompression-abuse dimensions', () => {
    expect(() => inspectBrandingImage(png(5000, 1))).toThrow(InvalidBrandingAssetError);
  });
});
