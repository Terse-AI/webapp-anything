import { zipSync } from "fflate";
import { runtimeRef } from "../build/bundle.js";
import { escapeHtml } from "../build/html.js";
import { VENDORED } from "../runtimes/registry.js";
import { needsUcrt } from "../scan/scan.js";
import { UserError } from "../util/errors.js";
import { posixBasename, posixDirname } from "../util/paths.js";
import type { Backend, BuildContext, BuildOutput } from "./types.js";

/** Where Boxedwine mounts the app zip inside its Wine prefix. */
const APP_DIR = "/home/username/.wine/dosdevices/c:/files";

/**
 * Boxedwine's shell script looks these elements up by id. We keep them all so the
 * upstream script runs unmodified, and hide the ones the player chrome replaces.
 */
function boxedwineStage(consoleApp: boolean): string {
  return `<div id="bw-root" class="bw-root">
  <div id="loading" hidden><figure id="spinner"><div class="spinner"></div></figure><div id="status"></div><progress value="0" max="100" id="progress"></progress></div>
  <div class="bw-hidden">
    <button id="startbtn" type="button">Start</button>
    <button id="uploadbtn" type="button">Add files</button>
    <input id="upload" type="file" multiple>
    <button id="downloadbtn" type="button">Get files</button>
    <a id="modalLink" href="#openModal">Open</a>
    <a id="modalLinkExe" href="#openModalExe">Open</a>
    <span id="sound-checkbox"><input type="checkbox" id="soundToggle" checked></span>
    <input type="checkbox" id="pointerLock">
    <input type="checkbox" id="showConsole"${consoleApp ? " checked" : ""}>
    <input type="checkbox" id="resize">
    <div id="openModal"><input id="selectedItem" type="text" readonly><div id="tree"></div><h3 id="loadStatus"></h3></div>
    <div id="openModalExe"><a id="openModalExeClick" href="#close">X</a><div id="message"></div><div id="items"></div></div>
  </div>
  <div id="dropzone" class="bw-screen"><canvas class="emscripten" id="canvas" tabindex="0" oncontextmenu="event.preventDefault()"></canvas></div>
  <textarea class="emscripten bw-console" id="output" rows="8" readonly${consoleApp ? "" : " hidden"}></textarea>
</div>`;
}

const STAGE_CSS = `<style>
.bw-root{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}
.bw-hidden{display:none!important}
.bw-screen{flex:1;min-height:0;width:100%;display:flex;align-items:center;justify-content:center}
#canvas{max-width:100%;max-height:100%;image-rendering:pixelated;outline:none;background:#000}
.bw-console{width:100%;height:30%;min-height:120px;background:#000;color:#d7dde8;border:0;border-top:1px solid #262c3b;padding:8px;font:13px/1.35 ui-monospace,Menlo,Consolas,monospace;resize:none}
</style>`;

export const windowsBackend: Backend = {
  id: "windows",
  title: "Windows (Boxedwine)",
  description:
    "Wine running on an emulated x86 CPU inside WebAssembly. Best for 16- and 32-bit GDI/DirectDraw programs.",
  runs: "16-bit and 32-bit Windows programs (no OpenGL/Direct3D)",
  assess(scan) {
    if (scan.kind !== "windows-program") return undefined;
    const exe = scan.executable;
    const warnings: string[] = [];
    if (exe?.format === "ne") {
      return {
        backend: "windows",
        score: 85,
        stability: "stable",
        reasons: ["16-bit Windows programs run well under Boxedwine."],
        warnings,
      };
    }
    if (exe?.format !== "pe") return undefined;
    if (exe.arch !== "x86") {
      return {
        backend: "windows",
        score: 0,
        stability: "experimental",
        reasons: [],
        warnings: [`Boxedwine only runs 32-bit x86 programs; this one is ${exe.bits}-bit ${exe.arch}.`],
      };
    }
    let score = exe.subsystem === "gui" ? 80 : 65;
    const reasons = ["32-bit Windows programs run under Wine in the browser."];
    if (exe.dotnet) {
      score = 25;
      warnings.push(".NET programs need Wine Mono, which the browser build does not include.");
    }
    if (exe.imports.some((i) => /^(opengl32|d3d8|d3d9|d3d1\d|dxgi)\.dll$/.test(i))) {
      score -= 40;
      warnings.push("OpenGL/Direct3D is not supported by the browser build of Boxedwine.");
    }
    if (exe.installer) score -= 15;
    // The scanner only warns when the archive does not ship its own UCRT DLLs.
    if (needsUcrt(exe.imports) && scan.warnings.some((w) => w.includes("Universal C Runtime"))) score -= 30;
    if (exe.subsystem === "console") reasons.push("Console output is shown below the screen.");
    return { backend: "windows", score: Math.max(score, 5), stability: "experimental", reasons, warnings };
  },
  async build(ctx: BuildContext): Promise<BuildOutput> {
    const { scan, tree, out, options } = ctx;
    if (!scan.entry) throw new UserError("No Windows program to start.");
    const spec = VENDORED.boxedwine;
    const exe = scan.executable;
    const consoleApp = exe?.format === "pe" && exe.subsystem === "console";

    // Pack the program (and its folder) as the app zip Boxedwine mounts at C:\files.
    const files: Record<string, Uint8Array> = {};
    let total = 0;
    for (const e of tree.entries) {
      total += e.size;
      if (total > 1024 * 1024 * 1024)
        throw new UserError("Windows bundles larger than 1 GB are not supported.");
      files[e.path] = await tree.read(e.path);
    }
    await out.write("app/app.zip", zipSync(files, { level: 6 }));

    const rt = await ctx.runtimes.ensure("boxedwine");
    const flavour = options.windows.threads ? "mt" : "st";
    const rootFs = options.windows.wine === "11" ? "wine11" : "wine6";
    const base = await out.addRuntime(
      rt,
      (f) => f.startsWith(`${flavour}/`) || f === `fs/${rootFs}.zip` || f === "LICENSE.txt",
    );

    const program = posixBasename(scan.entry);
    const dir = posixDirname(scan.entry);
    // boxedwine-shell.js splits this on & and = and only decodes %20, so keep it literal.
    if (/[&=%?#]/.test(program)) {
      throw new UserError(
        `Rename ${program}: Boxedwine cannot start programs whose names contain & = % ? or #.`,
      );
    }
    const params = [`app=app`, `root=${rootFs}`, `p=${program.replace(/ /g, "%20")}`, "sound=true"];
    if (options.windows.resolution && /^\d{3,4}x\d{3,4}$/.test(options.windows.resolution)) {
      params.push(`resolution=${options.windows.resolution}`);
    }
    const data = {
      base,
      flavour,
      params: params.join("&"),
      workingDir: dir ? `${APP_DIR}/${dir}` : APP_DIR,
      consoleApp,
    };
    return {
      type: "static",
      runtimes: [runtimeRef(spec, "vendored", base, "https://github.com/danoon2/Boxedwine/tree/26R1.0")],
      requirements: { crossOriginIsolation: options.windows.threads, network: [] },
      notices: [
        "Windows programs run under Wine (LGPL) inside Boxedwine. Microsoft Windows is not included or required.",
      ],
      warnings: [],
      page: {
        title: options.title,
        autostart: options.autostart,
        head: `<link rel="stylesheet" href="${escapeHtml(base + flavour)}/boxedwine.css">\n${STAGE_CSS}`,
        stage: boxedwineStage(consoleApp),
        data,
        boot: `
const { data } = WAA.config;
try {
  await WAA.start();
  WAA.status("Loading Wine…");
  // boxedwine-shell.js defines the global Module and Config objects used by boxedwine.js.
  await WAA.loadScript(data.base + data.flavour + "/boxedwine-shell.js");
  Config.urlParams = data.params;
  Config.locateRootBaseUrl = data.base + "fs/";
  Config.locateAppBaseUrl = "app/";
  Config.WorkingDir = data.workingDir;
  Config.showUploadDownload = false;
  const setStatus = Module.setStatus;
  Module.setStatus = function (text) {
    setStatus.call(this, text);
    const m = /([^(]+)\\((\\d+(?:\\.\\d+)?)\\/(\\d+)\\)/.exec(text || "");
    if (m) {
      WAA.status(m[1].trim() || "Downloading…");
      WAA.progress(Number(m[2]) / Number(m[3]));
    } else if (text) {
      WAA.status(text);
    }
  };
  Module.locateFile = (path) => data.base + data.flavour + "/" + path;
  const canvas = document.getElementById("canvas");
  // Wine's SDL backend asks for real fullscreen on the next click. Keep the program inside the page
  // (the toolbar's Full screen button covers that): Emscripten skips fullscreen when the canvas lacks the API.
  for (const api of ["requestFullscreen", "webkitRequestFullscreen"]) {
    Object.defineProperty(canvas, api, { value: undefined, configurable: true });
  }
  let shown = false;
  let ticker;
  const reveal = () => {
    if (shown) return;
    shown = true;
    clearInterval(ticker);
    WAA.ready();
    canvas.focus({ preventScroll: true });
  };
  // SDL only takes mouse focus on "mouseenter". The canvas usually appears under a pointer that
  // never re-enters it, so re-announce the pointer before input reaches SDL's own listeners.
  let lastEnter = 0;
  const announce = (e) => {
    if (e.timeStamp - lastEnter < 1500) return;
    lastEnter = e.timeStamp;
    canvas.dispatchEvent(new MouseEvent("mouseenter", { clientX: e.clientX, clientY: e.clientY }));
  };
  for (const type of ["mousedown", "mousemove", "touchstart"]) canvas.addEventListener(type, announce, true);
  // Boxedwine rewrites the tab title with its speed; keep ours.
  const title = document.title;
  new MutationObserver(() => { if (document.title !== title) document.title = title; })
    .observe(document.querySelector("title"), { childList: true });
  // Wine reports missing DLLs on stdout; turn that into a readable error instead of a black screen.
  const missing = new Set();
  const watch = (line) => {
    const m = /err:module:import_dll (?:Library|Loading library) ([^ ]+)/.exec(line);
    if (m) missing.add(m[1]);
    if (/Importing dlls for .* failed|status c0000135/.test(line)) {
      WAA.fail(
        "The program needs Windows DLLs that are not available: " + ([...missing].join(", ") || "unknown"),
        "Zip the program folder together with those DLLs and publish the zip.",
      );
    }
  };
  // Booting Wine on an emulated CPU takes a while. Keep the loading screen up until Wine maps the
  // program's first window (or the program writes console output), with a long safety timeout.
  const print = Module.print;
  Module.print = (...args) => {
    print(...args);
    const line = args.join(" ");
    watch(line);
    if (/^Showing Window/.test(line) || (data.consoleApp && !/^(ran main loop|Launching|Mounted|Loaded|Using|Command line|Starting)/.test(line))) {
      setTimeout(reveal, 1500);
    }
  };
  const printErr = Module.printErr;
  Module.printErr = (...args) => {
    printErr(...args);
    watch(args.join(" "));
  };
  Module.onRuntimeInitialized = () => {
    const started = Date.now();
    const tick = () => WAA.status("Starting Windows program… " + Math.round((Date.now() - started) / 1000) + "s");
    tick();
    ticker = setInterval(tick, 1000);
    setTimeout(reveal, 120000);
  };
  await WAA.loadScript(data.base + data.flavour + "/boxedwine.js");
} catch (err) {
  WAA.fail(err);
}
`,
      },
    };
  },
};
