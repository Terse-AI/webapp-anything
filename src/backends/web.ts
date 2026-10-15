import { escapeHtml } from "../build/html.js";
import { MANIFEST_FILE } from "../build/manifest.js";
import { readAsar } from "../formats/asar.js";
import { assetPath } from "../util/assets.js";
import { bufferSource } from "../util/bytes.js";
import { UserError } from "../util/errors.js";
import { posixBasename, posixDirname, safeRelativePath } from "../util/paths.js";
import type { Backend, BuildContext, BuildOutput } from "./types.js";

function redirectPage(target: string, title: string): string {
  const t = escapeHtml(target);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta http-equiv="refresh" content="0; url=${t}"></head>
<body><p><a href="${t}">Open ${escapeHtml(title)}</a></p></body></html>
`;
}

export const webBackend: Backend = {
  id: "web",
  title: "Static web app",
  description: "Publishes an existing HTML/JS app as-is.",
  runs: "Folders or zips with an index.html, single HTML files",
  assess(scan) {
    if (scan.kind !== "web-app") return undefined;
    return {
      backend: "web",
      score: 98,
      stability: "stable",
      reasons: ["Already a web app; published unchanged."],
      warnings: [],
    };
  },
  async build(ctx: BuildContext): Promise<BuildOutput> {
    const { scan, tree, out } = ctx;
    const index = scan.web?.index;
    if (!index) throw new UserError("No index.html found.");
    if (tree.container === "file") {
      await out.copyFromTree(tree, index, "index.html");
    } else {
      const root = posixDirname(index);
      const strip = root ? `${root}/` : "";
      if (tree.has(`${strip}${MANIFEST_FILE}`)) {
        throw new UserError(`The site already contains ${MANIFEST_FILE}, which webapp-anything reserves.`);
      }
      await out.copyTree(tree, "", strip);
    }
    return {
      type: "static",
      runtimes: [],
      requirements: { crossOriginIsolation: false, network: [] },
      notices: [],
      warnings: [],
    };
  },
};

/** Injects a small `require("electron")` stand-in so renderer code can load in a normal browser. */
function injectShim(html: string, shimHref: string, preloadHref?: string): string {
  const tags = `<script src="${escapeHtml(shimHref)}"></script>${preloadHref ? `<script src="${escapeHtml(preloadHref)}"></script>` : ""}`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tags}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tags}</head>`);
  return tags + html;
}

function relativeHref(fromPage: string, to: string): string {
  const depth = posixDirname(fromPage) ? posixDirname(fromPage).split("/").length : 0;
  return `${"../".repeat(depth)}${to}`;
}

export const electronBackend: Backend = {
  id: "electron",
  title: "Electron renderer",
  description:
    "Extracts the app's HTML/JS front end and stubs out the Electron/Node APIs it cannot use on the web.",
  runs: "Electron apps (app.asar or resources/app folders) whose UI works without Node.js",
  assess(scan) {
    if (scan.kind !== "electron-app") return undefined;
    const e = scan.electron;
    const warnings = [
      "Only the user interface is published. Anything the app does through its main process (files, native menus, IPC) will not work.",
    ];
    if (e?.usesNodeInRenderer)
      warnings.push("The renderer uses nodeIntegration, so pages that call Node.js APIs will fail.");
    if (!e?.page && e?.remoteUrl) {
      return {
        backend: "electron",
        score: 50,
        stability: "experimental",
        reasons: [`The app is a wrapper around ${e.remoteUrl}; the bundle links there.`],
        warnings: [],
      };
    }
    return {
      backend: "electron",
      score: e?.page ? 55 : 15,
      stability: "experimental",
      reasons: ["Renderer page found."],
      warnings,
    };
  },
  async build(ctx: BuildContext): Promise<BuildOutput> {
    const { scan, tree, out, options } = ctx;
    const e = scan.electron;
    if (!e) throw new UserError("Not an Electron app.");
    const warnings: string[] = [];
    // Collect the renderer files: from the asar itself, a resources/app folder, or a nested app.asar.
    let files: { path: string; read: () => Promise<Uint8Array> }[];
    let appRoot = e.appRoot;
    if (e.appRoot.endsWith(".asar")) {
      const asar = await tree.read(e.appRoot);
      const src = bufferSource(asar);
      const inner = await readAsar(src);
      files = inner
        .filter((f) => !f.unpacked)
        .map((f) => ({ path: f.path, read: () => src.read(f.offset, f.size) }));
      appRoot = "";
    } else {
      const strip = appRoot ? `${appRoot}/` : "";
      files = tree.entries
        .filter((x) => x.path.startsWith(strip))
        .map((x) => ({ path: x.path.slice(strip.length), read: () => tree.read(x.path) }));
    }
    const page = e.page
      ? appRoot
        ? e.page.slice(appRoot.length + 1)
        : e.page
      : files.find((f) => /(^|\/)index\.html?$/i.test(f.path))?.path;
    if (!page && e.remoteUrl) {
      await out.write("index.html", redirectPage(e.remoteUrl, options.title));
      return {
        type: "static",
        runtimes: [],
        requirements: { crossOriginIsolation: false, network: [new URL(e.remoteUrl).host] },
        notices: [],
        warnings: [`This Electron app only wraps ${e.remoteUrl}; the bundle redirects there.`],
      };
    }
    if (!page) throw new UserError("Could not find the Electron app's HTML page.");

    // Preload script, if the main process names one next to it.
    let preload: string | undefined;
    if (e.main) {
      const mainSrc = new TextDecoder().decode(await tree.read(e.main).catch(() => new Uint8Array()));
      const m = mainSrc.match(
        /preload\s*:\s*(?:path\.(?:join|resolve)\(\s*__dirname\s*,\s*)?["'`]([^"'`]+\.js)["'`]/,
      );
      const candidate = m ? safeRelativePath(m[1]!.replace(/^\.\//, "")) : null;
      if (candidate && files.some((f) => f.path === candidate)) preload = candidate;
    }

    for (const f of files) {
      if (f.path.endsWith(".node") || f.path === "waa.json" || f.path.startsWith("waa/")) continue;
      let data = await f.read();
      if (f.path === page) {
        const html = new TextDecoder().decode(data);
        data = new TextEncoder().encode(
          injectShim(
            html,
            relativeHref(page, "waa/electron-shim.js"),
            preload ? relativeHref(page, preload) : undefined,
          ),
        );
      }
      await out.write(f.path, data);
    }
    await out.copyFile(assetPath("player/electron-shim.js"), "waa/electron-shim.js");
    if (page !== "index.html" && !files.some((f) => f.path === "index.html")) {
      await out.write("index.html", redirectPage(page, options.title));
    }
    if (preload) warnings.push(`Loaded preload script ${posixBasename(preload)} with stubbed Electron APIs.`);
    return {
      type: "static",
      runtimes: [],
      requirements: { crossOriginIsolation: false, network: [] },
      notices: [
        "Electron APIs are replaced by browser stand-ins; IPC calls reject with an explanatory error.",
      ],
      warnings,
    };
  },
};
