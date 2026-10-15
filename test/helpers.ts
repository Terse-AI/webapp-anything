import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type { InstalledRuntime, RuntimeProvider } from "../src/runtimes/cache.js";
import { VENDORED, type VendoredRuntimeId } from "../src/runtimes/registry.js";

const temps: string[] = [];

afterEach(async () => {
  while (temps.length) await rm(temps.pop()!, { recursive: true, force: true });
});

export async function tempDir(prefix = "waa-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Write files (relative path → contents) into a fresh temp folder and return its path. */
export async function writeTree(files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = await tempDir();
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  return dir;
}

export async function writeFileTemp(name: string, data: string | Uint8Array): Promise<string> {
  const dir = await tempDir();
  const file = path.join(dir, name);
  await writeFile(file, data);
  return file;
}

/** Example file names produced by regex layout rules, so fake runtimes look realistic. */
const REGEX_SAMPLES: Record<VendoredRuntimeId, string[]> = {
  "js-dos": [
    "emulators/emulators.js",
    "emulators/wdosbox.js",
    "emulators/wdosbox.wasm",
    "emulators/wdosbox-x.js",
    "emulators/wdosbox-x.wasm",
    "emulators/wlibzip.wasm",
  ],
  ruffle: ["ruffle.js", "core.ruffle.abc.js", "abc.wasm"],
  v86: [],
  boxedwine: [
    "st/boxedwine.js",
    "st/boxedwine.wasm",
    "st/boxedwine-shell.js",
    "st/boxedwine.css",
    "mt/boxedwine.js",
    "mt/boxedwine.wasm",
  ],
  xterm: [],
};

/** A RuntimeProvider that fabricates tiny runtimes on disk instead of downloading. */
export class FakeRuntimes implements RuntimeProvider {
  readonly requested: VendoredRuntimeId[] = [];
  constructor(private readonly root: string) {}
  async ensure(id: VendoredRuntimeId): Promise<InstalledRuntime> {
    this.requested.push(id);
    const spec = VENDORED[id];
    const dir = path.join(this.root, `${id}@${spec.version}`);
    const files = new Set<string>(REGEX_SAMPLES[id]);
    for (const rule of spec.layout) if (typeof rule.from === "string") files.add(rule.to);
    for (const lic of spec.bundledLicenses) files.add(lic.to);
    for (const f of files) {
      const file = path.join(dir, ...f.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `fake ${id} ${f}`);
    }
    return { spec, dir, files: [...files].sort() };
  }
}
