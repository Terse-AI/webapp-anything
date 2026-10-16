import { unzlibSync, zlibSync } from "fflate";
import { crc32 } from "../util/bytes.js";
import { UserError } from "../util/errors.js";

/** 8-bit RGBA pixels. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a non-interlaced 8-bit PNG (grey, grey+alpha, RGB, RGBA or palette) to RGBA. */
export function decodePng(bytes: Uint8Array): Image {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new UserError("Not a PNG file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = view.getUint32(pos - 12 - len + 8);
      height = view.getUint32(pos - 12 - len + 12);
      depth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (depth !== 8)
    throw new UserError(`Unsupported PNG bit depth ${depth} (only 8-bit images are supported).`);
  if (interlace) throw new UserError("Interlaced PNGs are not supported.");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new UserError(`Unsupported PNG colour type ${colorType}.`);
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of idat) {
    joined.set(c, at);
    at += c.length;
  }
  const raw = unzlibSync(joined);
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels]! : 0;
      const up = prev[x]!;
      const upLeft = x >= channels ? prev[x - channels]! : 0;
      const v = line[x]!;
      switch (filter) {
        case 0:
          out[x] = v;
          break;
        case 1:
          out[x] = (v + left) & 255;
          break;
        case 2:
          out[x] = (v + up) & 255;
          break;
        case 3:
          out[x] = (v + ((left + up) >> 1)) & 255;
          break;
        case 4:
          out[x] = (v + paeth(left, up, upLeft)) & 255;
          break;
        default:
          throw new UserError(`Corrupt PNG (filter ${filter}).`);
      }
    }
    prev = out;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    switch (colorType) {
      case 0:
        rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]!;
        rgba[d + 3] = 255;
        break;
      case 4:
        rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]!;
        rgba[d + 3] = pixels[s + 1]!;
        break;
      case 2:
        rgba[d] = pixels[s]!;
        rgba[d + 1] = pixels[s + 1]!;
        rgba[d + 2] = pixels[s + 2]!;
        rgba[d + 3] = 255;
        break;
      case 3: {
        const idx = pixels[s]!;
        rgba[d] = palette?.[idx * 3] ?? 0;
        rgba[d + 1] = palette?.[idx * 3 + 1] ?? 0;
        rgba[d + 2] = palette?.[idx * 3 + 2] ?? 0;
        rgba[d + 3] = transparency?.[idx] ?? 255;
        break;
      }
      default:
        rgba.set(pixels.subarray(s, s + 4), d);
    }
  }
  return { width, height, data: rgba };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode RGBA pixels as a PNG (sub filter on every row). */
export function encodePng(image: Image): Uint8Array {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (row[x]! - (x >= 4 ? row[x - 4]! : 0)) & 255;
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function crop(image: Image, x: number, y: number, width: number, height: number): Image {
  const x0 = Math.max(0, Math.min(image.width, Math.round(x)));
  const y0 = Math.max(0, Math.min(image.height, Math.round(y)));
  const w = Math.max(0, Math.min(image.width - x0, Math.round(width)));
  const h = Math.max(0, Math.min(image.height - y0, Math.round(height)));
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const s = ((y0 + row) * image.width + x0) * 4;
    data.set(image.data.subarray(s, s + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}
