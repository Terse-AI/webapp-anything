import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidSlug } from "../util/paths.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const SYNC_CODE_RE = /^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/;

/** 100 random bits as XXXXX-XXXXX-XXXXX-XXXXX (base32, easy to type on another device). */
export function newSyncCode(): string {
  const bytes = randomBytes(13);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 20) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{5}/g)!.join("-");
}

interface SaveMeta {
  createdAt: number;
  updatedAt: number;
  size: number;
}

/**
 * Saved-game slots for sync between devices. A slot is addressed by app slug and sync code;
 * only a hash of the code is stored, so the data folder alone does not reveal codes.
 */
export class SaveStore {
  constructor(readonly dir: string) {}

  private slot(slug: string, code: string) {
    if (!isValidSlug(slug) || !SYNC_CODE_RE.test(code)) throw new Error("invalid save slot");
    const id = createHash("sha256").update(`${slug}\n${code}`).digest("hex");
    const base = path.join(this.dir, slug, id);
    return { meta: `${base}.json`, data: `${base}.bin` };
  }

  async create(slug: string): Promise<string> {
    const code = newSyncCode();
    const { meta } = this.slot(slug, code);
    await mkdir(path.dirname(meta), { recursive: true });
    const record: SaveMeta = { createdAt: Date.now(), updatedAt: 0, size: 0 };
    await writeFile(meta, JSON.stringify(record));
    return code;
  }

  async meta(slug: string, code: string): Promise<SaveMeta | undefined> {
    try {
      return JSON.parse(await readFile(this.slot(slug, code).meta, "utf8")) as SaveMeta;
    } catch {
      return undefined;
    }
  }

  /** The stored save, or undefined when the code is unknown or nothing was uploaded yet. */
  async read(slug: string, code: string): Promise<{ file: string; meta: SaveMeta } | undefined> {
    const meta = await this.meta(slug, code);
    if (!meta?.updatedAt) return undefined;
    const { data } = this.slot(slug, code);
    if (!(await stat(data).catch(() => undefined))) return undefined;
    return { file: data, meta };
  }

  /** Replace a slot's contents with `tmpFile` (moved into place). Returns undefined for unknown codes. */
  async write(slug: string, code: string, tmpFile: string, size: number): Promise<SaveMeta | undefined> {
    const meta = await this.meta(slug, code);
    if (!meta) return undefined;
    const slot = this.slot(slug, code);
    await rename(tmpFile, slot.data);
    // Strictly increasing so clients can tell versions apart even within one millisecond.
    const next: SaveMeta = { ...meta, updatedAt: Math.max(Date.now(), meta.updatedAt + 1), size };
    const tmp = `${slot.meta}.tmp-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(next));
    await rename(tmp, slot.meta);
    return next;
  }

  async deleteApp(slug: string): Promise<void> {
    if (!isValidSlug(slug)) return;
    await rm(path.join(this.dir, slug), { recursive: true, force: true });
  }
}
