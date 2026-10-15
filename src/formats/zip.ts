import { Inflate, inflateSync } from "fflate";
import { type ByteSource, crc32, Reader } from "../util/bytes.js";
import { UserError } from "../util/errors.js";
import { safeRelativePath } from "../util/paths.js";

export interface ZipEntry {
  /** Raw name as stored in the archive (POSIX separators). */
  readonly rawName: string;
  /** Safe normalised path, or null if the entry tries to escape the archive root. */
  readonly path: string | null;
  readonly isDirectory: boolean;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
  readonly encrypted: boolean;
}

export interface ZipLimits {
  maxEntries: number;
}

const DEFAULT_LIMITS: ZipLimits = { maxEntries: 200_000 };

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export function looksLikeZip(head: Uint8Array): boolean {
  const r = new Reader(head);
  const sig = r.u32(0);
  return sig === SIG_LOCAL || sig === SIG_EOCD;
}

const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return s;
}

/** Read the central directory without loading the archive into memory. */
export async function readZipDirectory(
  src: ByteSource,
  limits: Partial<ZipLimits> = {},
): Promise<ZipEntry[]> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const tailLen = Math.min(src.size, 65_535 + 22);
  const tail = new Reader(await src.read(src.size - tailLen, tailLen));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.u32(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UserError("Not a zip archive (end of central directory not found).");

  let entryCount = tail.u16(eocd + 10)!;
  let cdSize = tail.u32(eocd + 12)!;
  let cdOffset = tail.u32(eocd + 16)!;

  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locAt = eocd - 20;
    if (locAt >= 0 && tail.u32(locAt) === SIG_EOCD64_LOCATOR) {
      const recOffset = tail.u64(locAt + 8);
      if (recOffset === undefined) throw new UserError("Corrupt zip64 locator.");
      const rec = new Reader(await src.read(recOffset, 56));
      if (rec.u32(0) !== SIG_EOCD64) throw new UserError("Corrupt zip64 end of central directory.");
      entryCount = rec.u64(32) ?? Number.NaN;
      cdSize = rec.u64(40) ?? Number.NaN;
      cdOffset = rec.u64(48) ?? Number.NaN;
      if (!Number.isFinite(entryCount + cdSize + cdOffset)) throw new UserError("Zip64 archive too large.");
    }
  }
  if (entryCount > lim.maxEntries) {
    throw new UserError(`Archive has ${entryCount} entries; the limit is ${lim.maxEntries}.`);
  }
  if (cdOffset + cdSize > src.size) throw new UserError("Corrupt zip: central directory out of range.");

  const cd = new Reader(await src.read(cdOffset, cdSize));
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < entryCount; n++) {
    if (cd.u32(p) !== SIG_CENTRAL) throw new UserError("Corrupt zip: bad central directory entry.");
    const flags = cd.u16(p + 8)!;
    const method = cd.u16(p + 10)!;
    const crc = cd.u32(p + 16)!;
    let compressedSize = cd.u32(p + 20)!;
    let size = cd.u32(p + 24)!;
    const nameLen = cd.u16(p + 28)!;
    const extraLen = cd.u16(p + 30)!;
    const commentLen = cd.u16(p + 32)!;
    const externalAttrs = cd.u32(p + 38)!;
    let localHeaderOffset = cd.u32(p + 42)!;
    const nameBytes = cd.bytes.subarray(p + 46, p + 46 + nameLen);
    const rawName = decodeName(nameBytes, (flags & 0x800) !== 0).replace(/\\/g, "/");

    // zip64 extended information extra field
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.u16(e)!;
      const len = cd.u16(e + 2)!;
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = cd.u64(q) ?? Number.NaN;
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = cd.u64(q) ?? Number.NaN;
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff) {
          localHeaderOffset = cd.u64(q) ?? Number.NaN;
        }
      }
      e += 4 + len;
    }
    if (!Number.isFinite(size + compressedSize + localHeaderOffset)) {
      throw new UserError(`Zip entry too large: ${rawName}`);
    }
    const isDirectory = rawName.endsWith("/") || (externalAttrs & 0x10) !== 0;
    entries.push({
      rawName,
      path: safeRelativePath(rawName),
      isDirectory,
      method,
      compressedSize,
      size,
      crc32: crc,
      localHeaderOffset,
      encrypted: (flags & 1) !== 0,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function dataOffset(src: ByteSource, entry: ZipEntry): Promise<number> {
  const h = new Reader(await src.read(entry.localHeaderOffset, 30));
  if (h.u32(0) !== SIG_LOCAL) throw new UserError(`Corrupt zip: bad local header for ${entry.rawName}`);
  return entry.localHeaderOffset + 30 + h.u16(26)! + h.u16(28)!;
}

function assertReadable(entry: ZipEntry): void {
  if (entry.encrypted) throw new UserError(`Encrypted zip entries are not supported: ${entry.rawName}`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new UserError(`Unsupported zip compression method ${entry.method} for ${entry.rawName}`);
  }
}

/** Fully read and verify one entry. */
export async function readZipEntry(src: ByteSource, entry: ZipEntry, maxSize = 2 ** 31): Promise<Uint8Array> {
  assertReadable(entry);
  if (entry.size > maxSize)
    throw new UserError(`Zip entry ${entry.rawName} is larger than ${maxSize} bytes.`);
  const start = await dataOffset(src, entry);
  const raw = await src.read(start, entry.compressedSize);
  if (raw.byteLength !== entry.compressedSize) throw new UserError(`Truncated zip entry: ${entry.rawName}`);
  const data = entry.method === 0 ? raw : inflateSync(raw, { out: new Uint8Array(entry.size) });
  if (data.byteLength !== entry.size) throw new UserError(`Zip entry size mismatch: ${entry.rawName}`);
  if (crc32(data) !== entry.crc32) throw new UserError(`CRC mismatch in zip entry: ${entry.rawName}`);
  return data;
}

/** Read only the first `limit` decompressed bytes of an entry (for format sniffing). */
export async function readZipEntryHead(src: ByteSource, entry: ZipEntry, limit: number): Promise<Uint8Array> {
  assertReadable(entry);
  const start = await dataOffset(src, entry);
  if (entry.method === 0) return src.read(start, Math.min(limit, entry.compressedSize));
  const chunks: Uint8Array[] = [];
  let have = 0;
  let finished = false;
  const inflater = new Inflate((chunk, final) => {
    chunks.push(chunk);
    have += chunk.byteLength;
    if (final) finished = true;
  });
  const step = 64 * 1024;
  for (let off = 0; off < entry.compressedSize && have < limit && !finished; off += step) {
    const len = Math.min(step, entry.compressedSize - off);
    const piece = await src.read(start + off, len);
    inflater.push(piece, off + len >= entry.compressedSize);
  }
  const out = new Uint8Array(Math.min(limit, have));
  let at = 0;
  for (const c of chunks) {
    if (at >= out.byteLength) break;
    const take = Math.min(c.byteLength, out.byteLength - at);
    out.set(c.subarray(0, take), at);
    at += take;
  }
  return out;
}
