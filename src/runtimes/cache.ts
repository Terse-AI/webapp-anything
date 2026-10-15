import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readTar } from "../formats/tar.js";
import { readZipDirectory, readZipEntry } from "../formats/zip.js";
import { assetPath } from "../util/assets.js";
import { fileSource } from "../util/bytes.js";
import { UserError } from "../util/errors.js";
import { type Logger, silentLogger } from "../util/log.js";
import { resolveInside } from "../util/paths.js";
import {
  type LayoutRule,
  type RuntimeSource,
  runtimeDirName,
  VENDORED,
  type VendoredRuntime,
  type VendoredRuntimeId,
} from "./registry.js";

export interface InstalledRuntime {
  spec: VendoredRuntime;
  dir: string;
  /** Relative paths of every installed file. */
  files: string[];
}

export interface RuntimeProvider {
  ensure(id: VendoredRuntimeId): Promise<InstalledRuntime>;
}

interface InstallRecord {
  id: string;
  version: string;
  installedAt: string;
  files: { path: string; size: number; sha256: string }[];
}

const RECORD = ".waa-runtime.json";

export function defaultCacheDir(): string {
  if (process.env.WAA_CACHE_DIR) return path.resolve(process.env.WAA_CACHE_DIR);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "webapp-anything", "cache");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "webapp-anything");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "webapp-anything");
}

function npmTarballUrl(name: string, version: string): string {
  const registry = (process.env.WAA_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
  const base = name.startsWith("@") ? name.split("/")[1]! : name;
  return `${registry}/${name}/-/${base}-${version}.tgz`;
}

function sriMatches(data: Uint8Array, integrity: string): boolean {
  const [algo, expected] = integrity.split("-", 2) as [string, string];
  if (!["sha512", "sha384", "sha256"].includes(algo)) return false;
  return createHash(algo).update(data).digest("base64") === expected;
}

export class RuntimeCache implements RuntimeProvider {
  private readonly inflight = new Map<string, Promise<InstalledRuntime>>();
  constructor(
    readonly dir: string = defaultCacheDir(),
    private readonly log: Logger = silentLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  ensure(id: VendoredRuntimeId): Promise<InstalledRuntime> {
    const spec = VENDORED[id];
    if (!spec) throw new UserError(`Unknown runtime: ${id}`);
    const key = runtimeDirName(spec);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.install(spec).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** Location of an installed runtime, without installing it. */
  runtimeDir(spec: VendoredRuntime): string {
    return path.join(this.dir, "runtimes", runtimeDirName(spec));
  }

  async status(id: VendoredRuntimeId): Promise<{ installed: boolean; dir: string; size?: number }> {
    const spec = VENDORED[id];
    const dir = this.runtimeDir(spec);
    const rec = await this.readRecord(dir);
    return { installed: !!rec, dir, size: rec?.files.reduce((n, f) => n + f.size, 0) };
  }

  /** Re-hash installed files against the install record. */
  async verify(id: VendoredRuntimeId): Promise<string[]> {
    const spec = VENDORED[id];
    const dir = this.runtimeDir(spec);
    const rec = await this.readRecord(dir);
    if (!rec) return ["not installed"];
    const problems: string[] = [];
    for (const f of rec.files) {
      try {
        const data = await readFile(path.join(dir, ...f.path.split("/")));
        if (createHash("sha256").update(data).digest("hex") !== f.sha256)
          problems.push(`${f.path}: hash mismatch`);
      } catch {
        problems.push(`${f.path}: missing`);
      }
    }
    return problems;
  }

  async remove(id: VendoredRuntimeId): Promise<void> {
    await rm(this.runtimeDir(VENDORED[id]), { recursive: true, force: true });
  }

  private async readRecord(dir: string): Promise<InstallRecord | undefined> {
    try {
      return JSON.parse(await readFile(path.join(dir, RECORD), "utf8")) as InstallRecord;
    } catch {
      return undefined;
    }
  }

  private async install(spec: VendoredRuntime): Promise<InstalledRuntime> {
    const finalDir = this.runtimeDir(spec);
    const existing = await this.readRecord(finalDir);
    if (existing) return { spec, dir: finalDir, files: existing.files.map((f) => f.path) };

    this.log.info(`Downloading ${spec.name} ${spec.version} (one-time, cached in ${this.dir})…`);
    const downloads = await Promise.all(spec.sources.map((s) => this.download(s)));
    const tmpDir = `${finalDir}.tmp-${randomBytes(4).toString("hex")}`;
    await mkdir(tmpDir, { recursive: true });
    try {
      const files = new Map<string, Uint8Array>();
      for (const [i, source] of spec.sources.entries()) {
        const rules = spec.layout.filter((r) => r.source === i);
        if (rules.length === 0) continue;
        await this.applyLayout(source, downloads[i]!, rules, files);
      }
      for (const rule of spec.layout) {
        if (typeof rule.from === "string") {
          const produced = [...files.keys()].some((k) => k === rule.to);
          if (!produced)
            throw new Error(`${spec.name}: expected file missing from download: ${rule.from || rule.to}`);
        }
      }
      for (const lic of spec.bundledLicenses)
        files.set(lic.to, new Uint8Array(await readFile(assetPath(lic.asset))));
      const record: InstallRecord = {
        id: spec.id,
        version: spec.version,
        installedAt: new Date().toISOString(),
        files: [],
      };
      for (const [rel, data] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const dest = resolveInside(tmpDir, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, data);
        record.files.push({
          path: rel,
          size: data.byteLength,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      }
      await writeFile(path.join(tmpDir, RECORD), JSON.stringify(record, null, 2));
      await mkdir(path.dirname(finalDir), { recursive: true });
      try {
        await rename(tmpDir, finalDir);
      } catch (err) {
        // Another process won the race; use its copy.
        if (!(await this.readRecord(finalDir))) throw err;
        await rm(tmpDir, { recursive: true, force: true });
      }
      const rec = (await this.readRecord(finalDir))!;
      return { spec, dir: finalDir, files: rec.files.map((f) => f.path) };
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async applyLayout(
    source: RuntimeSource,
    file: string,
    rules: LayoutRule[],
    out: Map<string, Uint8Array>,
  ) {
    const place = (name: string, data: () => Promise<Uint8Array> | Uint8Array) => {
      for (const rule of rules) {
        if (typeof rule.from === "string") {
          if (rule.from === name) return { to: rule.to, data };
        } else {
          const m = name.match(rule.from);
          if (m) return { to: rule.to.replace(/\$(\d)/g, (_, d: string) => m[Number(d)] ?? ""), data };
        }
      }
      return undefined;
    };
    if (source.kind === "url" && rules.some((r) => r.from === "")) {
      const rule = rules.find((r) => r.from === "")!;
      out.set(rule.to, new Uint8Array(await readFile(file)));
      return;
    }
    if (source.kind === "npm" || file.endsWith(".tgz")) {
      for (const f of readTar(new Uint8Array(await readFile(file)))) {
        const hit = place(f.path, () => f.data);
        if (hit) out.set(hit.to, await hit.data());
      }
      return;
    }
    const src = await fileSource(file);
    try {
      for (const e of await readZipDirectory(src)) {
        if (e.isDirectory || !e.path) continue;
        const hit = place(e.path, () => readZipEntry(src, e));
        if (hit) out.set(hit.to, await hit.data());
      }
    } finally {
      await src.close();
    }
  }

  /** Download (or reuse) a verified source file and return its path. */
  private async download(source: RuntimeSource): Promise<string> {
    const dlDir = path.join(this.dir, "downloads");
    await mkdir(dlDir, { recursive: true });
    const url = source.kind === "npm" ? npmTarballUrl(source.name, source.version) : source.url;
    const id =
      source.kind === "npm"
        ? `${source.name.replace("/", "__")}-${source.version}.tgz`
        : `${source.sha256.slice(0, 16)}-${source.name}`;
    const dest = path.join(dlDir, id);
    const verify = async (p: string) => {
      const data = new Uint8Array(await readFile(p));
      return source.kind === "npm"
        ? sriMatches(data, source.integrity)
        : createHash("sha256").update(data).digest("hex") === source.sha256;
    };
    if (await stat(dest).catch(() => undefined)) {
      if (await verify(dest)) return dest;
      await rm(dest, { force: true });
    }
    if (process.env.WAA_OFFLINE === "1") {
      throw new UserError(`Runtime file ${id} is not cached and WAA_OFFLINE=1 is set.`);
    }
    const override = process.env.WAA_RUNTIME_MIRROR;
    const candidates = override ? [`${override.replace(/\/+$/, "")}/${id}`, url] : [url];
    let lastError: unknown;
    for (const candidate of candidates) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const tmp = `${dest}.part-${randomBytes(4).toString("hex")}`;
        try {
          const res = await this.fetchImpl(candidate, {
            redirect: "follow",
            signal: AbortSignal.timeout(15 * 60_000),
          });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${candidate}`);
          await pipeline(
            Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
            createWriteStream(tmp),
          );
          if (!(await verify(tmp))) throw new Error(`Integrity check failed for ${candidate}`);
          await rename(tmp, dest);
          return dest;
        } catch (err) {
          lastError = err;
          await rm(tmp, { force: true });
          this.log.debug(`download attempt ${attempt} failed: ${String(err)}`);
          if (String(err).includes("Integrity")) break;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }
    throw new UserError(
      `Could not download ${id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /** Copy a local file into the download cache (used by tests and air-gapped installs). */
  async seed(name: string, file: string): Promise<void> {
    const dlDir = path.join(this.dir, "downloads");
    await mkdir(dlDir, { recursive: true });
    await copyFile(file, path.join(dlDir, name));
  }
}
