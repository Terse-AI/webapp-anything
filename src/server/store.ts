import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BundleManifest } from "../build/manifest.js";
import { isValidSlug } from "../util/paths.js";

export interface StoredFile {
  hash: string;
  size: number;
}

export interface AppRecord {
  slug: string;
  title: string;
  manifest: BundleManifest;
  files: Record<string, StoredFile>;
  size: number;
  createdAt: string;
  updatedAt: string;
  /** sha256 of the per-app delete key (never the key itself). */
  keyHash: string;
}

export interface PublicApp {
  slug: string;
  title: string;
  backend: string;
  stability: string;
  source: BundleManifest["source"];
  size: number;
  files: number;
  createdAt: string;
  updatedAt: string;
}

export function publicApp(r: AppRecord): PublicApp {
  return {
    slug: r.slug,
    title: r.title,
    backend: r.manifest.backend.id,
    stability: r.manifest.backend.stability,
    source: r.manifest.source,
    size: r.size,
    files: Object.keys(r.files).length,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function hashFile(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const item of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...(await walk(dir, rel)));
    else if (item.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Content-addressed storage: every file is stored once under blobs/<hash>, so the
 * multi-megabyte runtimes shared by many apps cost disk space only once.
 */
export class AppStore {
  private readonly apps = new Map<string, AppRecord>();
  readonly blobsDir: string;
  readonly appsDir: string;
  readonly tmpDir: string;

  constructor(readonly dataDir: string) {
    this.blobsDir = path.join(dataDir, "blobs");
    this.appsDir = path.join(dataDir, "apps");
    this.tmpDir = path.join(dataDir, "tmp");
  }

  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.appsDir, { recursive: true });
    await rm(this.tmpDir, { recursive: true, force: true });
    await mkdir(this.tmpDir, { recursive: true });
    for (const name of await readdir(this.appsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await readFile(path.join(this.appsDir, name), "utf8")) as AppRecord;
        if (isValidSlug(rec.slug)) this.apps.set(rec.slug, rec);
      } catch {
        // A half-written record is ignored; the atomic rename means this should not happen.
      }
    }
  }

  async tempDir(prefix: string): Promise<string> {
    const dir = path.join(this.tmpDir, `${prefix}-${randomBytes(6).toString("hex")}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  blobPath(hash: string): string {
    return path.join(this.blobsDir, hash.slice(0, 2), hash);
  }

  get(slug: string): AppRecord | undefined {
    return this.apps.get(slug);
  }

  list(): AppRecord[] {
    return [...this.apps.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Move a built bundle folder into storage under `slug`, replacing any previous version. */
  async ingest(dir: string, slug: string, manifest: BundleManifest, keyHash: string): Promise<AppRecord> {
    const files: Record<string, StoredFile> = {};
    let size = 0;
    for (const rel of await walk(dir)) {
      const src = path.join(dir, ...rel.split("/"));
      const hash = await hashFile(src);
      const st = await stat(src);
      const dest = this.blobPath(hash);
      if (!(await stat(dest).catch(() => undefined))) {
        await mkdir(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.tmp-${randomBytes(4).toString("hex")}`;
        await copyFile(src, tmp);
        await rename(tmp, dest);
      }
      files[rel] = { hash, size: st.size };
      size += st.size;
    }
    const now = new Date().toISOString();
    const prev = this.apps.get(slug);
    const record: AppRecord = {
      slug,
      title: manifest.app.title,
      manifest: { ...manifest, app: { ...manifest.app, slug } },
      files,
      size,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      keyHash,
    };
    const file = path.join(this.appsDir, `${slug}.json`);
    const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, file);
    this.apps.set(slug, record);
    return record;
  }

  async delete(slug: string): Promise<boolean> {
    if (!this.apps.has(slug)) return false;
    this.apps.delete(slug);
    await rm(path.join(this.appsDir, `${slug}.json`), { force: true });
    return true;
  }

  /** Remove blobs no app references. Returns bytes freed. */
  async gc(): Promise<number> {
    const live = new Set<string>();
    for (const r of this.apps.values()) for (const f of Object.values(r.files)) live.add(f.hash);
    let freed = 0;
    for (const prefix of await readdir(this.blobsDir).catch(() => [] as string[])) {
      const sub = path.join(this.blobsDir, prefix);
      for (const name of await readdir(sub).catch(() => [] as string[])) {
        if (live.has(name) || name.includes(".tmp-")) continue;
        const p = path.join(sub, name);
        freed += (await stat(p).catch(() => ({ size: 0 }))).size;
        await rm(p, { force: true });
      }
    }
    return freed;
  }

  stats(): { apps: number; bytes: number } {
    let bytes = 0;
    for (const r of this.apps.values()) bytes += r.size;
    return { apps: this.apps.size, bytes };
  }
}
