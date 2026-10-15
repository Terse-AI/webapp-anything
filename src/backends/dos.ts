import { zipSync } from "fflate";
import { runtimeRef } from "../build/bundle.js";
import { VENDORED } from "../runtimes/registry.js";
import { UserError } from "../util/errors.js";
import { extname, posixBasename, posixDirname } from "../util/paths.js";
import type { Backend, BuildContext, BuildOutput } from "./types.js";

const IS_83 = /^[A-Z0-9_$~!#%&'(){}^`@-]{1,8}(\.[A-Z0-9_$~!#%&'(){}^`@-]{1,3})?$/i;

/** DOSBox config that mounts the bundle root as C: and starts the entry program. */
export function dosboxConf(
  entry: string | undefined,
  options: { cycles?: string; engine: "dosbox" | "dosboxX"; args: string[] },
) {
  const lines = [
    "[sdl]",
    "autolock=false",
    "",
    "[dosbox]",
    `machine=svga_s3`,
    "memsize=16",
    "",
    "[cpu]",
    "core=auto",
    "cputype=auto",
    `cycles=${options.cycles ?? "auto"}`,
    "",
    "[mixer]",
    "rate=44100",
    "",
    "[autoexec]",
    "@echo off",
    "mount c .",
    "c:",
    "cls",
  ];
  if (entry) {
    const dir = posixDirname(entry);
    if (dir) lines.push(`cd \\${dir.replace(/\//g, "\\")}`);
    const base = posixBasename(entry);
    const args = options.args.length ? ` ${options.args.join(" ")}` : "";
    lines.push(extname(base) === ".bat" ? `call ${base}${args}` : `${base}${args}`);
  }
  return `${lines.join("\r\n")}\r\n`;
}

export const dosBackend: Backend = {
  id: "dos",
  title: "DOS (js-dos)",
  description: "DOSBox compiled to WebAssembly, with save states, gamepad and touch controls.",
  runs: "DOS .EXE/.COM/.BAT programs, DOS/4GW games, js-dos bundles",
  assess(scan) {
    if (scan.kind === "jsdos-bundle") {
      return {
        backend: "dos",
        score: 99,
        stability: "stable",
        reasons: ["Ready-made js-dos bundle."],
        warnings: [],
      };
    }
    if (scan.kind !== "dos-program") return undefined;
    const warnings: string[] = [];
    let score = 95;
    const exe = scan.executable;
    if (exe?.format === "le" && !exe.extender) {
      score = 60;
      warnings.push("LE executable without a known DOS extender — it may be a Windows VxD driver.");
    }
    if (scan.entry?.split("/").some((seg) => !IS_83.test(seg))) {
      warnings.push(`"${scan.entry}" is not an 8.3 DOS file name; DOS will see a shortened name.`);
      score -= 10;
    }
    return {
      backend: "dos",
      score,
      stability: "stable",
      reasons: ["DOS programs run natively in DOSBox."],
      warnings,
    };
  },
  async build(ctx: BuildContext): Promise<BuildOutput> {
    const { scan, tree, out, options } = ctx;
    const spec = VENDORED["js-dos"];
    const warnings: string[] = [];
    const bundleName = "app.jsdos";

    if (scan.kind === "jsdos-bundle" && tree.container === "zip" && tree.has(".jsdos/dosbox.conf")) {
      await out.copyFile(ctx.inputPath, `app/${bundleName}`);
    } else {
      const files: Record<string, Uint8Array> = {};
      let entry = scan.entry;
      if (tree.container === "file") {
        // A lone program: give it a DOS-safe name.
        const original = tree.entries[0]!.path;
        let base = posixBasename(original).toUpperCase();
        if (!IS_83.test(base)) {
          const ext = extname(base) || ".EXE";
          base = `${
            base
              .slice(0, base.length - ext.length)
              .replace(/[^A-Z0-9_]/g, "")
              .slice(0, 8) || "PROGRAM"
          }${ext.toUpperCase()}`;
          warnings.push(`Renamed ${original} to ${base} for DOS.`);
        }
        files[base] = await tree.read(original);
        entry = base;
      } else {
        // A js-dos bundle folder may sit inside one top-level directory; its root is where .jsdos/ lives.
        const conf = tree.entries.find(
          (e) => e.path === ".jsdos/dosbox.conf" || e.path.endsWith("/.jsdos/dosbox.conf"),
        );
        const strip =
          scan.kind === "jsdos-bundle" && conf ? conf.path.slice(0, -".jsdos/dosbox.conf".length) : "";
        let total = 0;
        for (const e of tree.entries) {
          if (strip && !e.path.startsWith(strip)) continue;
          total += e.size;
          if (total > 1024 * 1024 * 1024) {
            throw new UserError("DOS bundles larger than 1 GB are not supported.");
          }
          files[e.path.slice(strip.length)] = await tree.read(e.path);
        }
      }
      if (scan.kind !== "jsdos-bundle" && !entry) throw new UserError("No DOS program to start.");
      if (!files[".jsdos/dosbox.conf"]) {
        files[".jsdos/dosbox.conf"] = new TextEncoder().encode(
          dosboxConf(entry, { cycles: options.dos.cycles, engine: options.dos.engine, args: options.args }),
        );
      }
      await out.write(`app/${bundleName}`, zipSync(files, { level: 6 }));
    }

    let base: string;
    let delivery: "vendored" | "cdn";
    if (options.runtime === "cdn" && spec.cdn?.base) {
      base = spec.cdn.base;
      delivery = "cdn";
    } else {
      const rt = await ctx.runtimes.ensure("js-dos");
      // DOSBox-X (Windows 9x capable) adds ~16 MB; only ship it when asked for.
      const wantX = options.dos.engine === "dosboxX";
      base = await out.addRuntime(rt, (f) => wantX || !f.startsWith("emulators/wdosbox-x"));
      delivery = "vendored";
    }

    const data = {
      bundle: `app/${bundleName}`,
      base,
      engine: options.dos.engine,
    };
    return {
      type: "static",
      runtimes: [
        runtimeRef(spec, delivery, base, `https://github.com/caiiiycuk/js-dos/tree/v${spec.version}`),
      ],
      requirements: { crossOriginIsolation: false, network: delivery === "cdn" ? ["cdn.jsdelivr.net"] : [] },
      notices: [],
      warnings,
      page: {
        title: options.title,
        autostart: options.autostart,
        head: `<link rel="stylesheet" href="${base}js-dos.css">\n<style>#dos{width:100%;height:100%}</style>`,
        stage: `<div id="dos"></div>`,
        data,
        boot: `
const { data } = WAA.config;
try {
  await WAA.start();
  WAA.status("Loading DOSBox…");
  await WAA.loadScript(new URL(data.base + "js-dos.js", location.href).href);
  const props = Dos(document.getElementById("dos"), {
    url: new URL(data.bundle, location.href).href,
    pathPrefix: new URL(data.base + "emulators/", location.href).href,
    backend: data.engine,
    backendLocked: true,
    autoStart: true,
    theme: "dark",
    thinSidebar: true,
    onEvent: (event) => {
      if (event === "ci-ready") WAA.ready();
    },
  });
  props.setNoCloud?.(true);
  window.waaDos = props;
} catch (err) {
  WAA.fail(err);
}
`,
      },
    };
  },
};
