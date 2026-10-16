import path from "node:path";
import { getBackend, type Plan, planFor } from "../backends/index.js";
import type { BuildOptions } from "../backends/types.js";
import type { RuntimeProvider } from "../runtimes/cache.js";
import { type ScanOptions, scanInput } from "../scan/scan.js";
import type { ScanReport } from "../scan/types.js";
import { UserError } from "../util/errors.js";
import { type Logger, silentLogger } from "../util/log.js";
import { posixBasename, slugify } from "../util/paths.js";
import { BundleWriter, newManifest } from "./bundle.js";
import type { BackendId, BundleManifest } from "./manifest.js";

export interface BuildRequest extends ScanOptions {
  input: string;
  outDir: string;
  backend?: BackendId;
  force?: boolean;
  title?: string;
  slug?: string;
  runtime?: BuildOptions["runtime"];
  autostart?: boolean;
  offline?: boolean;
  args?: string[];
  dos?: Partial<BuildOptions["dos"]>;
  windows?: Partial<BuildOptions["windows"]>;
  java?: Partial<BuildOptions["java"]>;
  disk?: Partial<BuildOptions["disk"]>;
  /** Boot this OS image (hard disk or CD) with the input on a CD-ROM drive. */
  guest?: string;
  guestEngine?: "v86" | "dosboxX";
}

export interface BuildResult {
  outDir: string;
  manifest: BundleManifest;
  scan: ScanReport;
  plan: Plan;
  files: number;
  bytes: number;
  warnings: string[];
}

/** Drop undefined fields so they do not override defaults when spread. */
function defined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function defaultTitle(scan: ScanReport): string {
  const from =
    scan.entry && scan.input.container !== "file" ? scan.input.name : (scan.entry ?? scan.input.name);
  const base = posixBasename(from).replace(/\.[a-z0-9]{1,6}$/i, "");
  const words = base.replace(/[_-]+/g, " ").trim();
  if (!words) return "Untitled app";
  // Keep DOS-style shouting names readable (GAME → Game) and capitalise the rest.
  const cased =
    words === words.toUpperCase() && words.length > 1
      ? words.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
      : words;
  return cased.charAt(0).toUpperCase() + cased.slice(1);
}

export async function buildApp(
  req: BuildRequest,
  deps: { runtimes: RuntimeProvider; log?: Logger },
): Promise<BuildResult> {
  const log = deps.log ?? silentLogger;
  const { report: scan, tree, inputPath } = await scanInput(req.input, req);
  try {
    const plan: Plan = req.guest
      ? {
          chosen: {
            backend: "guest",
            score: 100,
            stability: "experimental",
            reasons: ["Boots the guest OS image with the program on a CD-ROM drive."],
            warnings: [],
          },
          candidates: [],
        }
      : planFor(scan, req.backend);
    if (!plan.chosen) throw new UserError(plan.unsupported ?? "No backend can run this input.");
    const backend = getBackend(plan.chosen.backend)!;
    const title = (req.title ?? defaultTitle(scan)).slice(0, 120);
    const slug = req.slug ?? slugify(title);
    const options: BuildOptions = {
      title,
      slug,
      runtime: req.runtime ?? "vendor",
      autostart: req.autostart ?? false,
      offline: req.offline ?? true,
      args: req.args ?? [],
      dos: { engine: "dosbox", ...defined(req.dos) },
      windows: { threads: false, wine: "6", ...defined(req.windows) },
      java: { ...defined(req.java) },
      disk: { ...defined(req.disk) },
      ...(req.guest ? { guest: { image: path.resolve(req.guest), engine: req.guestEngine ?? "v86" } } : {}),
    };
    const out = new BundleWriter(path.resolve(req.outDir));
    await out.init({ force: req.force, sourceName: scan.input.name });
    log.debug(`building with ${backend.id}`, { entry: scan.entry });
    const result = await backend.build({ scan, tree, inputPath, out, options, runtimes: deps.runtimes, log });
    const manifest = newManifest({
      type: result.type,
      app: { title, slug },
      backend: { id: backend.id, stability: plan.chosen.stability },
      source: {
        name: scan.input.name,
        size: scan.input.size,
        sha256: scan.input.sha256,
        kind: scan.kind,
        entry: scan.entry,
      },
      runtimes: result.runtimes,
      requirements: result.requirements,
      notices: result.notices,
    });
    if (result.type === "static")
      await out.finalizeStatic(manifest, result.page, { offline: options.offline });
    else await out.finalizeContainer(manifest);
    const { files, bytes } = out.stats();
    const warnings = [...new Set([...scan.warnings, ...plan.chosen.warnings, ...result.warnings])];
    return { outDir: out.dir, manifest, scan, plan, files, bytes, warnings };
  } finally {
    await tree.close();
  }
}
