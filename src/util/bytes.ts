import { type FileHandle, open } from "node:fs/promises";

/** Random-access view over a file or an in-memory buffer. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export function bufferSource(data: Uint8Array): ByteSource {
  return {
    size: data.byteLength,
    async read(offset, length) {
      const start = Math.max(0, Math.min(offset, data.byteLength));
      const end = Math.max(start, Math.min(offset + length, data.byteLength));
      return data.subarray(start, end);
    },
    async close() {},
  };
}

export async function fileSource(path: string): Promise<ByteSource> {
  const handle: FileHandle = await open(path, "r");
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const start = Math.max(0, Math.min(offset, size));
      const len = Math.max(0, Math.min(length, size - start));
      const buf = new Uint8Array(len);
      let done = 0;
      while (done < len) {
        const { bytesRead } = await handle.read(buf, done, len - done, start + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return done === len ? buf : buf.subarray(0, done);
    },
    async close() {
      await handle.close();
    },
  };
}

/** Little helpers around DataView that never throw on short buffers. */
export class Reader {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.byteLength;
  }
  has(offset: number, size: number): boolean {
    return offset >= 0 && size >= 0 && offset + size <= this.bytes.byteLength;
  }
  u8(offset: number): number | undefined {
    return this.has(offset, 1) ? this.view.getUint8(offset) : undefined;
  }
  u16(offset: number, le = true): number | undefined {
    return this.has(offset, 2) ? this.view.getUint16(offset, le) : undefined;
  }
  u32(offset: number, le = true): number | undefined {
    return this.has(offset, 4) ? this.view.getUint32(offset, le) : undefined;
  }
  u64(offset: number, le = true): number | undefined {
    if (!this.has(offset, 8)) return undefined;
    const v = this.view.getBigUint64(offset, le);
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined;
  }
  ascii(offset: number, length: number): string {
    if (!this.has(offset, 0)) return "";
    const end = Math.min(this.bytes.byteLength, offset + length);
    let s = "";
    for (let i = offset; i < end; i++) s += String.fromCharCode(this.bytes[i]!);
    return s;
  }
  /** NUL-terminated string starting at offset (max `limit` bytes). */
  cstring(offset: number, limit = 4096): string {
    let s = "";
    for (let i = offset; i < this.bytes.byteLength && i < offset + limit; i++) {
      const c = this.bytes[i]!;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  startsWith(prefix: readonly number[], offset = 0): boolean {
    if (!this.has(offset, prefix.length)) return false;
    return prefix.every((b, i) => this.bytes[offset + i] === b);
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
