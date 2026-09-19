// Minimal ambient type declaration for `gifenc`, which ships no types of its
// own (its package.json has no "types"/"typings" field). Only the surface
// actually used by scripts/lib/gif.ts is declared.
declare module 'gifenc' {
  export interface GifWriteFrameOptions {
    palette?: number[][];
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
    repeat?: number;
    first?: boolean;
  }

  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array | Uint8ClampedArray,
      width: number,
      height: number,
      opts?: GifWriteFrameOptions
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  export interface GIFEncoderOptions {
    auto?: boolean;
    initialCapacity?: number;
  }

  export function GIFEncoder(opts?: GIFEncoderOptions): GIFEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: Record<string, unknown>
  ): number[][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string
  ): Uint8Array;

  interface GifencDefault {
    GIFEncoder: typeof GIFEncoder;
    quantize: typeof quantize;
    applyPalette: typeof applyPalette;
  }

  const gifenc: GifencDefault;
  export default gifenc;
}
