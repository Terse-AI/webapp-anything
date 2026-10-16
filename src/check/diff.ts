import type { Image } from "./png.js";

export interface DiffResult {
  /** Fraction of pixels that differ beyond the tolerance (1 when sizes differ). */
  mismatch: number;
  differentPixels: number;
  sameSize: boolean;
  /** Greyed-out actual image with differing pixels painted red. */
  diff?: Image;
}

/**
 * Pixel comparison for screenshots of the same program in the same runtime. A pixel differs
 * when any channel moves by more than `tolerance` (0–255), which absorbs compression and
 * anti-aliasing noise but catches real changes.
 */
export function diffImages(expected: Image, actual: Image, tolerance = 24): DiffResult {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { mismatch: 1, differentPixels: actual.width * actual.height, sameSize: false };
  }
  const out = new Uint8Array(actual.data.length);
  let differ = 0;
  const n = actual.width * actual.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(expected.data[o]! - actual.data[o]!),
      Math.abs(expected.data[o + 1]! - actual.data[o + 1]!),
      Math.abs(expected.data[o + 2]! - actual.data[o + 2]!),
    );
    if (d > tolerance) {
      differ++;
      out[o] = 255;
      out[o + 1] = 32;
      out[o + 2] = 48;
    } else {
      const grey = Math.round(
        0.3 * actual.data[o]! + 0.59 * actual.data[o + 1]! + 0.11 * actual.data[o + 2]!,
      );
      out[o] = out[o + 1] = out[o + 2] = Math.round(grey * 0.35 + 160 * 0.65);
    }
    out[o + 3] = 255;
  }
  return {
    mismatch: differ / n,
    differentPixels: differ,
    sameSize: true,
    diff: { width: actual.width, height: actual.height, data: out },
  };
}

/** Area-average downscale to a small greyscale grid. */
function thumbnail(image: Image, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  const counts = new Float64Array(w * h);
  for (let y = 0; y < image.height; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / image.height));
    for (let x = 0; x < image.width; x++) {
      const tx = Math.min(w - 1, Math.floor((x * w) / image.width));
      const o = (y * image.width + x) * 4;
      out[ty * w + tx]! += 0.3 * image.data[o]! + 0.59 * image.data[o + 1]! + 0.11 * image.data[o + 2]!;
      counts[ty * w + tx]! += 1;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = counts[i]! ? out[i]! / counts[i]! : 0;
  return out;
}

/**
 * Structural similarity (0–1) on 64×48 greyscale thumbnails: robust to different sizes,
 * fonts and colours. Used to compare an original program with a reimplementation.
 */
export function similarity(a: Image, b: Image): number {
  const W = 64;
  const H = 48;
  const x = thumbnail(a, W, H);
  const y = thumbnail(b, W, H);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let windows = 0;
  const S = 8;
  for (let wy = 0; wy + S <= H; wy += S / 2) {
    for (let wx = 0; wx + S <= W; wx += S / 2) {
      let mx = 0;
      let my = 0;
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) {
          mx += x[(wy + j) * W + wx + i]!;
          my += y[(wy + j) * W + wx + i]!;
        }
      mx /= S * S;
      my /= S * S;
      let vx = 0;
      let vy = 0;
      let cov = 0;
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) {
          const dx = x[(wy + j) * W + wx + i]! - mx;
          const dy = y[(wy + j) * W + wx + i]! - my;
          vx += dx * dx;
          vy += dy * dy;
          cov += dx * dy;
        }
      const n = S * S - 1;
      vx /= n;
      vy /= n;
      cov /= n;
      total += ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
      windows++;
    }
  }
  return Math.max(0, Math.min(1, total / windows));
}
