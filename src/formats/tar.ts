import { gunzipSync } from "fflate";
import { safeRelativePath } from "../util/paths.js";

export interface TarFile {
  path: string;
  data: Uint8Array;
}

function field(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const s = field(block, offset, length).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = new TextDecoder().decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp < 0) break;
    const len = Number.parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(sp + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

export interface TarInput {
  path: string;
  data: Uint8Array;
  /** Unix permission bits (default 0o644). */
  mode?: number;
}

function writeField(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  block.set(bytes.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeField(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** Build an uncompressed POSIX (ustar/pax) tar archive. */
export function writeTar(files: readonly TarInput[], mtime = Math.floor(Date.now() / 1000)): Uint8Array {
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number, mode: number, type: string) => {
    const h = new Uint8Array(512);
    writeField(h, 0, 100, name);
    writeOctal(h, 100, 8, mode);
    writeOctal(h, 108, 8, 0);
    writeOctal(h, 116, 8, 0);
    writeOctal(h, 124, 12, size);
    writeOctal(h, 136, 12, mtime);
    h.fill(0x20, 148, 156);
    writeField(h, 156, 1, type);
    writeField(h, 257, 6, "ustar\0");
    writeField(h, 263, 2, "00");
    let sum = 0;
    for (const b of h) sum += b;
    writeField(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    return h;
  };
  const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);
  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.path).byteLength;
    if (nameBytes > 99) {
      const record = (len: number) => `${len} path=${f.path}\n`;
      let len = record(0).length + 1;
      while (new TextEncoder().encode(record(len)).byteLength !== len)
        len = new TextEncoder().encode(record(len)).byteLength;
      const pax = new TextEncoder().encode(record(len));
      blocks.push(header("././@PaxHeader", pax.byteLength, 0o644, "x"), pax, pad(pax.byteLength));
    }
    blocks.push(
      header(f.path.slice(0, 99), f.data.byteLength, f.mode ?? 0o644, "0"),
      f.data,
      pad(f.data.byteLength),
    );
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.byteLength;
  }
  return out;
}

/** Extract regular files from a (gzipped) tar archive. Unsafe paths are skipped. */
export function readTar(input: Uint8Array): TarFile[] {
  const buf = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
  const files: TarFile[] = [];
  let pos = 0;
  let longName: string | undefined;
  let pax: Record<string, string> = {};
  while (pos + 512 <= buf.length) {
    const block = buf.subarray(pos, pos + 512);
    if (block.every((b) => b === 0)) break;
    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156] || 0x30);
    const magic = field(block, 257, 6);
    let name = field(block, 0, 100);
    if (magic.startsWith("ustar")) {
      const prefix = field(block, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = pos + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue;
    const finalName = pax.path ?? longName ?? name;
    longName = undefined;
    pax = {};
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    const safe = safeRelativePath(finalName);
    if (!safe) continue;
    files.push({ path: safe, data });
  }
  return files;
}
