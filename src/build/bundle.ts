import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstalledRuntime } from "../runtimes/cache.js";
import { runtimeDirName } from "../runtimes/registry.js";
import type { FileTree } from "../scan/tree.js";
import { assetPath, packageVersion } from "../util/assets.js";
import { UserError } from "../util/errors.js";
import { resolveInside, safeRelativePath } from "../util/paths.js";
import { escapeHtml, inlineJson } from "./html.js";
import { type BundleManifest, bundleHeaders, MANIFEST_FILE, type RuntimeRef } from "./manifest.js";

export interface PageSpec {
  title: string;
  /** Extra markup for <head>. */
  head?: string;
  /** Markup inside #waa-stage. */
  stage: string;
  /** Boot code (runs as a module after waa/player.js). */
  boot: string;
  /** Data made available to the boot code as `WAA.config.data`. */
  data?: unknown;
  autostart?: boolean;
  /** Text under the play button. */
  gateLabel?: string;
}

export class BundleWriter {
  private readonly written = new Map<string, number>();

  constructor(readonly dir: string) {}

  /**
   * Prepare the output folder. Rebuilding the same input replaces the old bundle; anything
   * else (a non-empty folder we did not create, or a bundle of another program) needs force.
   */
  async init(options: { force?: boolean; sourceName?: string } = {}): Promise<void> {
    const st = await stat(this.dir).catch(() => undefined);
    if (st && !st.isDirectory()) throw new UserError(`Output path exists and is not a folder: ${this.dir}`);
    if (st) {
      const items = await readdir(this.dir);
      if (items.length > 0) {
        let previous: string | undefined;
        if (items.includes(MANIFEST_FILE)) {
          try {
            previous = (
              JSON.parse(await readFile(path.join(this.dir, MANIFEST_FILE), "utf8")) as BundleManifest
            ).source?.name;
          } catch {
            previous = undefined;
          }
        }
        const sameApp = previous !== undefined && previous === options.sourceName;
        if (!sameApp && !options.force) {
          throw new UserError(
            previous
              ? `Output folder ${this.dir} holds a bundle of ${previous}.`
              : `Output folder ${this.dir} is not empty.`,
            "Pick another --out folder, or pass --force to replace its contents.",
          );
        }
        await rm(this.dir, { recursive: true, force: true });
      }
    }
    await mkdir(this.dir, { recursive: true });
  }

  private target(rel: string): string {
    const safe = safeRelativePath(rel);
    if (!safe) throw new UserError(`Unsafe bundle path: ${rel}`);
    return resolveInside(this.dir, safe);
  }

  has(rel: string): boolean {
    return this.written.has(safeRelativePath(rel) ?? rel);
  }

  async write(rel: string, data: string | Uint8Array): Promise<void> {
    const dest = this.target(rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
    this.written.set(
      safeRelativePath(rel)!,
      typeof data === "string" ? Buffer.byteLength(data) : data.byteLength,
    );
  }

  async copyFile(src: string, rel: string): Promise<void> {
    const dest = this.target(rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest, constants.COPYFILE_FICLONE);
    this.written.set(safeRelativePath(rel)!, (await stat(dest)).size);
  }

  async copyFromTree(tree: FileTree, from: string, rel: string): Promise<void> {
    const dest = this.target(rel);
    await tree.copyTo(from, dest);
    this.written.set(safeRelativePath(rel)!, tree.size(from) ?? (await stat(dest)).size);
  }

  /** Copy every file of the input tree below `prefix` (optionally stripping `stripPrefix`). */
  async copyTree(tree: FileTree, prefix: string, stripPrefix = ""): Promise<number> {
    let n = 0;
    for (const e of tree.entries) {
      if (stripPrefix && !e.path.startsWith(stripPrefix)) continue;
      const rel = stripPrefix ? e.path.slice(stripPrefix.length) : e.path;
      if (!rel) continue;
      await this.copyFromTree(tree, e.path, prefix ? `${prefix}/${rel}` : rel);
      n++;
    }
    return n;
  }

  /**
   * Copy (a subset of) an installed runtime into `runtime/<id>@<version>/` and
   * return that folder's bundle-relative path (with trailing slash).
   */
  async addRuntime(rt: InstalledRuntime, include: (file: string) => boolean = () => true): Promise<string> {
    const base = `runtime/${runtimeDirName(rt.spec)}`;
    for (const f of rt.files) {
      if (!include(f)) continue;
      await this.copyFile(path.join(rt.dir, ...f.split("/")), `${base}/${f}`);
    }
    return `${base}/`;
  }

  stats(): { files: number; bytes: number } {
    let bytes = 0;
    for (const n of this.written.values()) bytes += n;
    return { files: this.written.size, bytes };
  }

  /** Write the player page and every support file, then the manifest. */
  async finalizeStatic(
    manifest: BundleManifest,
    page: PageSpec | undefined,
    options: { offline?: boolean } = {},
  ) {
    const offline = options.offline !== false;
    if (page) {
      if (this.has("index.html")) throw new UserError("Internal error: index.html written twice.");
      await this.write("index.html", renderPage(manifest, page, { offline }));
      for (const f of ["player.js", "player.css", "icon.svg"])
        await this.copyFile(assetPath(`player/${f}`), `waa/${f}`);
      await this.write("sw.js", renderServiceWorker(manifest));
      await this.write(
        "manifest.webmanifest",
        JSON.stringify(
          {
            name: manifest.app.title,
            short_name: manifest.app.title.slice(0, 24),
            start_url: "./",
            scope: "./",
            display: "standalone",
            background_color: "#0b0d12",
            theme_color: "#151924",
            icons: [{ src: "waa/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
          },
          null,
          2,
        ),
      );
    }
    if (!this.has("_headers")) await this.write("_headers", renderNetlifyHeaders(manifest));
    if (!this.has("vercel.json")) await this.write("vercel.json", renderVercelConfig(manifest));
    await this.write("THIRD-PARTY-NOTICES.md", renderNotices(manifest));
    await this.write(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async finalizeContainer(manifest: BundleManifest): Promise<void> {
    await this.write(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

const PLAY_ICON =
  '<svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5Z"/></svg>';

export function renderPage(manifest: BundleManifest, page: PageSpec, options: { offline: boolean }): string {
  const config = {
    title: page.title,
    backend: manifest.backend.id,
    isolation: manifest.requirements.crossOriginIsolation,
    autostart: page.autostart === true,
    offline: options.offline,
    data: page.data ?? null,
  };
  const title = escapeHtml(page.title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${title} — running in your browser.">
<meta name="generator" content="webapp-anything ${escapeHtml(manifest.generator.version)}">
<meta property="og:title" content="${title}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#151924">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="waa/icon.svg" type="image/svg+xml">
${page.head ?? ""}
<link rel="stylesheet" href="waa/player.css">
</head>
<body data-backend="${escapeHtml(manifest.backend.id)}">
<header class="waa-bar">
  <span class="waa-title">${title}</span>
  <button class="waa-btn" id="waa-info-btn" type="button" aria-label="About this app">ⓘ<span class="waa-label">&nbsp;About</span></button>
  <button class="waa-btn" id="waa-fullscreen" type="button" aria-label="Full screen">⛶<span class="waa-label">&nbsp;Full screen</span></button>
</header>
<main class="waa-stage" id="waa-stage">
${page.stage}
</main>
<div class="waa-overlay" id="waa-overlay" data-state="gate">
  <div class="waa-card">
    <div class="waa-gate">
      <button class="waa-play" id="waa-play" type="button" aria-label="Start ${title}">${PLAY_ICON}</button>
      <p class="waa-sub">${escapeHtml(page.gateLabel ?? "Click to start")}</p>
    </div>
    <div class="waa-loading" role="status" aria-live="polite">
      <progress id="waa-progress"></progress>
      <p class="waa-sub" id="waa-status">Loading…</p>
    </div>
    <div class="waa-failure" role="alert">
      <strong>Could not start</strong>
      <p id="waa-error"></p>
      <p class="waa-sub" id="waa-hint" hidden></p>
      <button class="waa-btn" id="waa-retry" type="button">Reload</button>
    </div>
  </div>
</div>
<dialog class="waa-dialog" id="waa-info">
  <h2>${title}</h2>
  <div id="waa-info-body">Loading…</div>
  <footer><span>Made with <a href="https://github.com/Terse-AI/webapp-anything" target="_blank" rel="noopener">webapp-anything</a></span><button class="waa-btn" id="waa-info-close" type="button">Close</button></footer>
</dialog>
<script id="waa-config" type="application/json">${inlineJson(config)}</script>
<script src="waa/player.js"></script>
<script type="module">
${page.boot.trim()}
</script>
</body>
</html>
`;
}

export function renderServiceWorker(manifest: BundleManifest): string {
  const tag = createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 12);
  return `/* webapp-anything service worker: offline cache${manifest.requirements.crossOriginIsolation ? " + cross-origin isolation" : ""}. */
const CACHE = "waa-${tag}";
const COI = ${manifest.requirements.crossOriginIsolation};
const SCOPE = new URL("./", self.location).pathname;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("waa-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isolate(response) {
  if (!COI || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  const url = new URL(request.url);
  const local = url.origin === self.location.origin && url.pathname.startsWith(SCOPE);
  if (!local) {
    if (COI) event.respondWith(fetch(request).then(isolate));
    return;
  }
  const ranged = request.headers.has("range");
  const immutable = url.pathname.startsWith(SCOPE + "runtime/");
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (immutable && !ranged) {
        const hit = await cache.match(request);
        if (hit) return isolate(hit);
      }
      try {
        const response = await fetch(request);
        if (!ranged && response.status === 200) cache.put(request, response.clone()).catch(() => {});
        return isolate(response);
      } catch (err) {
        const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
        if (hit) return isolate(hit);
        throw err;
      }
    })(),
  );
});
`;
}

function renderNetlifyHeaders(manifest: BundleManifest): string {
  const lines = ["/*"];
  for (const [k, v] of Object.entries(bundleHeaders(manifest))) lines.push(`  ${k}: ${v}`);
  lines.push("/runtime/*", "  Cache-Control: public, max-age=31536000, immutable", "");
  return lines.join("\n");
}

function renderVercelConfig(manifest: BundleManifest): string {
  return `${JSON.stringify(
    {
      headers: [
        {
          source: "/(.*)",
          headers: Object.entries(bundleHeaders(manifest)).map(([key, value]) => ({ key, value })),
        },
        {
          source: "/runtime/(.*)",
          headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function renderNotices(manifest: BundleManifest): string {
  const parts = [
    `# Third-party notices for "${manifest.app.title}"`,
    "",
    "This bundle was generated by [webapp-anything](https://github.com/Terse-AI/webapp-anything) " +
      `${manifest.generator.version} (MIT License).`,
    "",
    `The original program (\`${manifest.source.name}\`) belongs to its authors; this bundle does not change its license.`,
    "",
    "## Runtimes",
    "",
  ];
  for (const r of manifest.runtimes) {
    parts.push(
      `- **${r.name} ${r.version}** — ${r.license}. ${r.homepage}` +
        (r.delivery === "vendored"
          ? ` (files in \`${r.location}\`, license text included)`
          : ` (loaded from ${r.location})`) +
        (r.source ? `. Source code: ${r.source}` : ""),
    );
  }
  if (manifest.notices.length) parts.push("", "## Notices", "", ...manifest.notices.map((n) => `- ${n}`));
  return `${parts.join("\n")}\n`;
}

export function runtimeRef(
  spec: { id: string; name: string; version: string; license: string; homepage: string },
  delivery: RuntimeRef["delivery"],
  location: string,
  source?: string,
): RuntimeRef {
  return {
    id: spec.id,
    name: spec.name,
    version: spec.version,
    license: spec.license,
    homepage: spec.homepage,
    delivery,
    location,
    source,
  };
}

export function newManifest(
  fields: Omit<BundleManifest, "schema" | "generator" | "createdAt">,
): BundleManifest {
  return {
    schema: 1,
    generator: { name: "webapp-anything", version: packageVersion() },
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

export async function readBundleManifest(dir: string): Promise<BundleManifest> {
  const { isBundleManifest } = await import("./manifest.js");
  let raw: string;
  try {
    raw = await readFile(path.join(dir, MANIFEST_FILE), "utf8");
  } catch {
    throw new UserError(
      `${dir} is not a webapp-anything bundle (no ${MANIFEST_FILE}).`,
      "Run `waa build` first.",
    );
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isBundleManifest(parsed))
    throw new UserError(`${path.join(dir, MANIFEST_FILE)} is not a valid bundle manifest.`);
  return parsed;
}
