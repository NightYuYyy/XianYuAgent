import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImageForUpload, MAX_IMAGE_EDGE } from './image-compress';

function fileOf(bytes: number, type = 'image/jpeg', name = 'photo.jpg') {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('compressImageForUpload', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('keeps small images and non-raster files untouched', async () => {
    const small = fileOf(10_000);
    expect(await compressImageForUpload(small)).toBe(small);
    const gif = fileOf(2_000_000, 'image/gif', 'a.gif');
    expect(await compressImageForUpload(gif)).toBe(gif);
  });

  it('falls back to the original when the browser cannot decode', async () => {
    vi.stubGlobal('createImageBitmap', async () => { throw new Error('decode failed'); });
    const big = fileOf(2_000_000);
    expect(await compressImageForUpload(big)).toBe(big);
  });

  it('downscales large photos to a JPEG with the long edge capped', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4000, height: 3000, close() {} }));
    const draw = vi.fn();
    let canvasWidth = 0;
    let canvasHeight = 0;
    const canvas = {
      set width(value: number) { canvasWidth = value; },
      set height(value: number) { canvasHeight = value; },
      getContext: () => ({ fillStyle: '', fillRect: () => {}, drawImage: draw }),
      toBlob: (callback: (blob: Blob | null) => void, type: string) => callback(new Blob([new Uint8Array(300_000)], { type })),
    };
    vi.stubGlobal('document', { createElement: (tag: string) => { if (tag !== 'canvas') throw new Error(`unexpected ${tag}`); return canvas; } });
    const result = await compressImageForUpload(fileOf(3_000_000, 'image/png', 'shot.png'));
    expect(canvasWidth).toBe(MAX_IMAGE_EDGE);
    expect(canvasHeight).toBe(1200);
    expect(draw).toHaveBeenCalledOnce();
    expect(result.type).toBe('image/jpeg');
    expect(result.name).toBe('shot.jpg');
    expect(result.size).toBe(300_000);
  });
});
