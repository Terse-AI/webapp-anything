import { Unzlib } from "fflate";
import { Reader } from "../util/bytes.js";

export interface SwfInfo {
  compression: "none" | "zlib" | "lzma";
  version: number;
  /** Uncompressed length from the header. */
  length: number;
  width?: number;
  height?: number;
  frameRate?: number;
  frameCount?: number;
  actionScript3?: boolean;
  usesNetwork?: boolean;
}

export function isSwf(head: Uint8Array): boolean {
  const s = new Reader(head).ascii(0, 3);
  return (s === "FWS" || s === "CWS" || s === "ZWS") && head.length >= 8;
}

function inflateHead(data: Uint8Array, limit: number): Uint8Array {
  const out: Uint8Array[] = [];
  let have = 0;
  const z = new Unzlib((chunk) => {
    out.push(chunk);
    have += chunk.length;
  });
  const step = 16 * 1024;
  try {
    for (let i = 0; i < data.length && have < limit; i += step) {
      z.push(data.subarray(i, i + step), i + step >= data.length);
    }
  } catch {
    // Truncated input is expected when we only have the head of the file.
  }
  const buf = new Uint8Array(Math.min(have, limit));
  let at = 0;
  for (const c of out) {
    if (at >= buf.length) break;
    const take = Math.min(c.length, buf.length - at);
    buf.set(c.subarray(0, take), at);
    at += take;
  }
  return buf;
}

export function parseSwf(head: Uint8Array): SwfInfo | undefined {
  if (!isSwf(head)) return undefined;
  const r = new Reader(head);
  const sig = r.ascii(0, 3);
  const info: SwfInfo = {
    compression: sig === "FWS" ? "none" : sig === "CWS" ? "zlib" : "lzma",
    version: r.u8(3)!,
    length: r.u32(4)!,
  };
  let body: Uint8Array | undefined;
  if (info.compression === "none") body = head.subarray(8);
  else if (info.compression === "zlib") body = inflateHead(head.subarray(8), 64 * 1024);
  if (!body || body.length < 10) return info;

  // RECT: 5-bit field size followed by xmin, xmax, ymin, ymax (twips).
  let bit = 0;
  const readBits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = body![bit >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  const readSigned = (n: number): number => {
    const v = readBits(n);
    return n > 0 && v & (1 << (n - 1)) ? v - (1 << n) : v;
  };
  const nbits = readBits(5);
  const xmin = readSigned(nbits);
  const xmax = readSigned(nbits);
  const ymin = readSigned(nbits);
  const ymax = readSigned(nbits);
  const pos = Math.ceil(bit / 8);
  const b = new Reader(body);
  info.width = Math.round((xmax - xmin) / 20);
  info.height = Math.round((ymax - ymin) / 20);
  const rate = b.u16(pos);
  if (rate !== undefined) info.frameRate = rate / 256;
  info.frameCount = b.u16(pos + 2);

  // First tag should be FileAttributes (69) for SWF 8+.
  const tagHeader = b.u16(pos + 4);
  if (tagHeader !== undefined && tagHeader >> 6 === 69) {
    const flags = b.u8(pos + 6) ?? 0;
    info.actionScript3 = (flags & 0x08) !== 0;
    info.usesNetwork = (flags & 0x01) !== 0;
  }
  return info;
}

export interface DiskImageInfo {
  type: "iso" | "floppy" | "hdd";
  bootable: boolean;
  label?: string;
}

const FLOPPY_SIZES = new Set([160, 180, 320, 360, 720, 1200, 1440, 1680, 1722, 2880].map((k) => k * 1024));

/**
 * Identify CD-ROM, floppy and hard-disk images. `head` must contain at least the
 * first 36 KiB for ISO detection.
 */
export function parseDiskImage(head: Uint8Array, size: number, ext: string): DiskImageInfo | undefined {
  const r = new Reader(head);
  if (r.ascii(0x8001, 5) === "CD001") {
    const label = r.ascii(0x8028, 32).trim() || undefined;
    // El Torito boot record lives in the volume descriptor after the primary one.
    let bootable = false;
    for (let sector = 17; sector < 32; sector++) {
      const at = sector * 2048;
      if (!r.has(at, 7)) break;
      if (
        r.u8(at) === 0 &&
        r.ascii(at + 1, 5) === "CD001" &&
        r.ascii(at + 7, 23) === "EL TORITO SPECIFICATION"
      ) {
        bootable = true;
        break;
      }
      if (r.u8(at) === 255) break;
    }
    return { type: "iso", bootable, label };
  }
  const bootSig = r.u16(510) === 0xaa55;
  const diskExt = [".img", ".ima", ".vfd", ".flp", ".dsk", ".hdd", ".raw", ".bin", ".vhd"].includes(ext);
  if (FLOPPY_SIZES.has(size) && (bootSig || diskExt)) return { type: "floppy", bootable: bootSig };
  if (diskExt && bootSig && size >= 2 * 1024 * 1024) return { type: "hdd", bootable: true };
  if ((ext === ".img" || ext === ".hdd" || ext === ".raw") && size >= 2 * 1024 * 1024 && size % 512 === 0) {
    return { type: "hdd", bootable: bootSig };
  }
  return undefined;
}
