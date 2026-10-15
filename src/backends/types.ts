import type { BundleWriter, PageSpec } from "../build/bundle.js";
import type { BackendId, RuntimeRef } from "../build/manifest.js";
import type { RuntimeProvider } from "../runtimes/cache.js";
import type { FileTree } from "../scan/tree.js";
import type { ScanReport } from "../scan/types.js";
import type { Logger } from "../util/log.js";

export type Stability = "stable" | "experimental";

export interface Assessment {
  backend: BackendId;
  /** 0–100: how likely this backend is to run the input well. */
  score: number;
  stability: Stability;
  reasons: string[];
  warnings: string[];
}

export interface BuildOptions {
  title: string;
  slug: string;
  /** "vendor" copies runtimes into the bundle; "cdn" loads them from public CDNs where possible. */
  runtime: "vendor" | "cdn";
  autostart: boolean;
  offline: boolean;
  /** Program arguments (where the backend supports them). */
  args: string[];
  dos: { engine: "dosbox" | "dosboxX"; cycles?: string };
  windows: { threads: boolean; wine: "6" | "11"; resolution?: string };
  java: { mainClass?: string; version?: 8 | 11 | 17 };
  disk: { memoryMB?: number };
}

export interface BuildContext {
  scan: ScanReport;
  tree: FileTree;
  /** Path of the original input on disk. */
  inputPath: string;
  out: BundleWriter;
  options: BuildOptions;
  runtimes: RuntimeProvider;
  log: Logger;
}

export interface BuildOutput {
  type: "static" | "container";
  page?: PageSpec;
  runtimes: RuntimeRef[];
  requirements: { crossOriginIsolation: boolean; network: string[] };
  notices: string[];
  warnings: string[];
}

export interface Backend {
  id: BackendId;
  title: string;
  description: string;
  /** Human-readable list of what it runs. */
  runs: string;
  assess(scan: ScanReport): Assessment | undefined;
  build(ctx: BuildContext): Promise<BuildOutput>;
}
