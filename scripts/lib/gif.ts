// Assembles the history of dated SVG snapshots into a single animated GIF.
//
// Each SVG is rasterized with sharp at a bounded width, flattened onto a
// white background (GIF has no real alpha channel, and mixing per-frame
// transparency looks inconsistent), then quantized and encoded with the
// pure-JS `gifenc` library (no native dependency beyond sharp itself).

import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
// `gifenc` ships as a CommonJS bundle without a package.json "exports" map;
// its named exports aren't always reliably detected by Node's CJS/ESM
// interop across Node versions, so import the default and destructure it
// instead of relying on named imports from a CJS module.
import gifencPkg from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifencPkg;

const DEFAULT_WIDTH = 1000;

export interface GifOptions {
  frameMs?: number;
  lastFrameMs?: number;
  maxFrames?: number;
  width?: number;
}

/**
 * @param historySvgPaths - SVG file paths in chronological order (oldest
 *   first). Only the most recent `opts.maxFrames` are used.
 * @param outPath - where to write the resulting GIF.
 * @returns outPath, once written.
 */
export async function buildGif(
  historySvgPaths: string[],
  outPath: string,
  opts: GifOptions = {}
): Promise<string> {
  const { frameMs = 900, lastFrameMs = 2500, maxFrames = 60, width = DEFAULT_WIDTH } = opts;

  if (!Array.isArray(historySvgPaths) || historySvgPaths.length === 0) {
    throw new Error('buildGif requires at least one SVG path (historySvgPaths is empty).');
  }

  // Keep memory bounded and the GIF a reasonable size: only the most recent
  // N snapshots are animated. Paths are expected in chronological order, so
  // "most recent" is simply the tail of the array.
  const selected =
    historySvgPaths.length > maxFrames
      ? historySvgPaths.slice(historySvgPaths.length - maxFrames)
      : historySvgPaths;

  // Pass 1: read each SVG and determine the tallest raster at the target
  // width. A GIF has one fixed logical canvas size, so every frame is later
  // composed (top-anchored, letterboxed with white) onto that shared size
  // rather than each frame carrying its own dimensions.
  //
  // Note: sharp's .metadata() reports the *input* image's intrinsic
  // dimensions even when a .resize() is chained beforehand — it does not
  // reflect pending pipeline operations. So the scaled height at our target
  // width has to be computed manually from the intrinsic aspect ratio
  // rather than read back off metadata() after resize().
  const svgBuffers: Buffer[] = [];
  let canvasHeight = 0;
  for (const svgPath of selected) {
    const buffer = await readFile(svgPath);
    const { width: intrinsicWidth, height: intrinsicHeight } = await sharp(buffer).metadata();
    if (intrinsicWidth && intrinsicHeight) {
      const scaledHeight = Math.round((intrinsicHeight * width) / intrinsicWidth);
      canvasHeight = Math.max(canvasHeight, scaledHeight);
    }
    svgBuffers.push(buffer);
  }

  if (canvasHeight === 0) {
    throw new Error('Could not determine a raster height for any of the supplied SVGs.');
  }

  const encoder = GIFEncoder();

  for (let i = 0; i < svgBuffers.length; i++) {
    // Process one frame at a time (rather than holding every raster buffer
    // in memory at once) to keep peak memory reasonable even at maxFrames.
    const { data } = await sharp(svgBuffers[i])
      .resize({
        width,
        height: canvasHeight,
        fit: 'contain',
        position: 'top',
        background: '#0d1117',
      })
      .flatten({ background: '#0d1117' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const palette = quantize(data, 256);
    const indexed = applyPalette(data, palette);

    const isLast = i === svgBuffers.length - 1;
    encoder.writeFrame(indexed, width, canvasHeight, {
      palette,
      delay: isLast ? lastFrameMs : frameMs,
    });
  }

  encoder.finish();
  await writeFile(outPath, Buffer.from(encoder.bytes()));
  return outPath;
}
