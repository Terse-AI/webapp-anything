import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { type AsarFile, looksLikeAsar, readAsar } from "../formats/asar.js";
import {
  looksLikeZip,
  readZipDirectory,
  readZipEntry,
  readZipEntryHead,
  type ZipEntry,
} from "../formats/zip.js";
import { type ByteSource, fileSource } from "../util/bytes.js";
import { UserError } from "../util/errors.js";
import { posixBasename, safeRelativePath } from "../util/paths.js";

export interface TreeEntry {
  readonly path: string;
  readonly size: number;
}

/** A read-only view over the user's input: a single file, a folder, a zip or an asar archive. */
export interface FileTree {
  readonly container: "file" | "dir" | "zip" | "asar";
  /** Base name of the input (file or folder name). */
  readonly name: string;
  readonly entries: readonly TreeEntry[];
  /** Entries that were skipped because their paths were unsafe. */
  readonly skipped: readonly string[];
  has(p: string): boolean;
  size(p: string): number | undefined;
  read(p: string): Promise<Uint8Array>;
  head(p: string, bytes: number): Promise<Uint8Array>;
  /** Copy an entry to a native file path, creating parent directories. */
  copyTo(p: string, dest: string): Promise<void>;
  close(): Promise<void>;
}

export interface TreeLimits {
  maxEntries: number;
  /** Total uncompressed bytes we are willing to unpack (zip-bomb guard). */
  maxTotalBytes: number;
}

export const DEFAULT_TREE_LIMITS: TreeLimits = {
  maxEntries: 100_000,
  maxTotalBytes: 8 * 1024 ** 3,
};

abstract class BaseTree implements FileTree {
  abstract readonly container: FileTree["container"];
  protected readonly index = new Map<string, TreeEntry>();
  constructor(
    readonly name: string,
    readonly entries: readonly TreeEntry[],
    readonly skipped: readonly string[],
  ) {
    for (const e of entries) this.index.set(e.path, e);
  }
  has(p: string): boolean {
    return this.index.has(p);
  }
  size(p: string): number | undefined {
    return this.index.get(p)?.size;
  }
  protected require(p: string): TreeEntry {
    const e = this.index.get(p);
    if (!e) throw new UserError(`No such file in input: ${p}`);
    return e;
  }
  abstract read(p: string): Promise<Uint8Array>;
  abstract head(p: string, bytes: number): Promise<Uint8Array>;
  async copyTo(p: string, dest: string): Promise<void> {
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await this.read(p));
  }
  async close(): Promise<void> {}
}

class SingleFileTree extends BaseTree {
  readonly container = "file" as const;
  constructor(
    private readonly file: string,
    name: string,
    size: number,
  ) {
    super(name, [{ path: name, size }], []);
  }
  async read(p: string): Promise<Uint8Array> {
    this.require(p);
    return new Uint8Array(await readFile(this.file));
  }
  async head(p: string, bytes: number): Promise<Uint8Array> {
    this.require(p);
    const src = await fileSource(this.file);
    try {
      return await src.read(0, bytes);
    } finally {
      await src.close();
    }
  }
  override async copyTo(p: string, dest: string): Promise<void> {
    this.require(p);
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(createReadStream(this.file), createWriteStream(dest));
  }
}

class DirTree extends BaseTree {
  readonly container = "dir" as const;
  constructor(
    private readonly root: string,
    name: string,
    entries: TreeEntry[],
    skipped: string[],
  ) {
    super(name, entries, skipped);
  }
  private native(p: string): string {
    this.require(p);
    return path.join(this.root, ...p.split("/"));
  }
  async read(p: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.native(p)));
  }
  async head(p: string, bytes: number): Promise<Uint8Array> {
    const src = await fileSource(this.native(p));
    try {
      return await src.read(0, bytes);
    } finally {
      await src.close();
    }
  }
  override async copyTo(p: string, dest: string): Promise<void> {
    const from = this.native(p);
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(createReadStream(from), createWriteStream(dest));
  }
}

class ZipTree extends BaseTree {
  readonly container = "zip" as const;
  constructor(
    private readonly src: ByteSource,
    private readonly zipEntries: Map<string, ZipEntry>,
    name: string,
    entries: TreeEntry[],
    skipped: string[],
  ) {
    super(name, entries, skipped);
  }
  async read(p: string): Promise<Uint8Array> {
    this.require(p);
    return readZipEntry(this.src, this.zipEntries.get(p)!);
  }
  async head(p: string, bytes: number): Promise<Uint8Array> {
    this.require(p);
    return readZipEntryHead(this.src, this.zipEntries.get(p)!, bytes);
  }
  override async close(): Promise<void> {
    await this.src.close();
  }
}

class AsarTree extends BaseTree {
  readonly container = "asar" as const;
  constructor(
    private readonly src: ByteSource,
    private readonly asarFiles: Map<string, AsarFile>,
    private readonly unpackedRoot: string,
    name: string,
    entries: TreeEntry[],
    skipped: string[],
  ) {
    super(name, entries, skipped);
  }
  async read(p: string): Promise<Uint8Array> {
    this.require(p);
    const f = this.asarFiles.get(p)!;
    if (f.unpacked) return new Uint8Array(await readFile(path.join(this.unpackedRoot, ...p.split("/"))));
    return this.src.read(f.offset, f.size);
  }
  async head(p: string, bytes: number): Promise<Uint8Array> {
    const data = await this.read(p);
    return data.subarray(0, bytes);
  }
  override async close(): Promise<void> {
    await this.src.close();
  }
}

async function walkDir(
  root: string,
  limits: TreeLimits,
): Promise<{ entries: TreeEntry[]; skipped: string[] }> {
  const entries: TreeEntry[] = [];
  const skipped: string[] = [];
  let total = 0;
  const visit = async (dir: string, rel: string) => {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        skipped.push(childRel);
        continue;
      }
      if (item.isDirectory()) {
        if (item.name === ".git") continue;
        await visit(full, childRel);
      } else if (item.isFile()) {
        const safe = safeRelativePath(childRel);
        if (!safe) {
          skipped.push(childRel);
          continue;
        }
        const st = await lstat(full);
        total += st.size;
        entries.push({ path: safe, size: st.size });
        if (entries.length > limits.maxEntries) {
          throw new UserError(`Folder has more than ${limits.maxEntries} files.`);
        }
        if (total > limits.maxTotalBytes)
          throw new UserError("Folder is larger than the configured size limit.");
      }
    }
  };
  await visit(root, "");
  return { entries, skipped };
}

/** Open any supported input as a FileTree. `displayName` overrides the file name (server uploads). */
export async function openTree(
  input: string,
  options: { displayName?: string; limits?: Partial<TreeLimits> } = {},
): Promise<FileTree> {
  const limits = { ...DEFAULT_TREE_LIMITS, ...options.limits };
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(input);
  } catch {
    throw new UserError(`Input not found: ${input}`);
  }
  const name = options.displayName ?? posixBasename(path.resolve(input).replace(/\\/g, "/"));
  if (st.isDirectory()) {
    const { entries, skipped } = await walkDir(input, limits);
    if (entries.length === 0) throw new UserError("The input folder is empty.");
    return new DirTree(input, name, entries, skipped);
  }
  if (!st.isFile()) throw new UserError(`Not a regular file: ${input}`);
  const src = await fileSource(input);
  const head = await src.read(0, 64);
  if (looksLikeZip(head)) {
    try {
      const zipEntries = await readZipDirectory(src, { maxEntries: limits.maxEntries });
      const map = new Map<string, ZipEntry>();
      const entries: TreeEntry[] = [];
      const skipped: string[] = [];
      let total = 0;
      for (const e of zipEntries) {
        if (e.isDirectory) continue;
        if (!e.path) {
          skipped.push(e.rawName);
          continue;
        }
        if (map.has(e.path)) continue;
        map.set(e.path, e);
        entries.push({ path: e.path, size: e.size });
        total += e.size;
      }
      if (total > limits.maxTotalBytes) {
        throw new UserError(
          "Archive expands beyond the configured size limit.",
          "Raise --max-size if this is expected.",
        );
      }
      return new ZipTree(src, map, name, entries, skipped);
    } catch (err) {
      await src.close();
      throw err;
    }
  }
  if (looksLikeAsar(await src.read(0, 32))) {
    try {
      const files = await readAsar(src);
      const map = new Map(files.map((f) => [f.path, f]));
      return new AsarTree(
        src,
        map,
        `${input}.unpacked`,
        name,
        files.map((f) => ({ path: f.path, size: f.size })),
        [],
      );
    } catch (err) {
      await src.close();
      throw err;
    }
  }
  await src.close();
  return new SingleFileTree(input, name, st.size);
}
