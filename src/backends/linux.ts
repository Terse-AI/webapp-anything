import { runtimeRef } from "../build/bundle.js";
import { writeTar } from "../formats/tar.js";
import { CDN, CHEERPX_DEBIAN_DISK, VENDORED } from "../runtimes/registry.js";
import { UserError } from "../util/errors.js";
import { posixBasename, posixDirname } from "../util/paths.js";
import type { Backend, BuildContext, BuildOutput } from "./types.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const linuxBackend: Backend = {
  id: "linux",
  title: "Linux (CheerpX)",
  description: "An x86-to-WebAssembly JIT running a Debian userland; terminal programs get a full xterm.",
  runs: "32-bit x86 Linux terminal programs and scripts (bash, python3, perl…)",
  assess(scan) {
    if (scan.kind === "script") {
      return {
        backend: "linux",
        score: 60,
        stability: "experimental",
        reasons: [
          `Runs with ${scan.script?.interpreter ?? "its interpreter"} from a Debian image streamed on demand.`,
        ],
        warnings: [CDN.cheerpx.notice],
      };
    }
    if (scan.kind !== "linux-program") return undefined;
    const exe = scan.executable;
    if (exe?.format !== "elf") return undefined;
    if (exe.arch !== "x86") {
      return {
        backend: "linux",
        score: 0,
        stability: "experimental",
        reasons: [],
        warnings: [`CheerpX runs 32-bit x86 binaries; this one is ${exe.bits}-bit ${exe.arch}.`],
      };
    }
    const warnings = [CDN.cheerpx.notice];
    let score = exe.staticallyLinked ? 80 : 70;
    if (exe.gui) {
      score = 20;
      warnings.unshift(
        "This program needs a display server (X11/Wayland); only terminal programs are supported in the browser.",
      );
    }
    return {
      backend: "linux",
      score,
      stability: "experimental",
      reasons: [
        exe.staticallyLinked
          ? "Static 32-bit x86 binary."
          : "Dynamically linked; libraries come from Debian.",
      ],
      warnings,
    };
  },
  async build(ctx: BuildContext): Promise<BuildOutput> {
    const { scan, tree, out, options } = ctx;
    if (!scan.entry) throw new UserError("No program to run.");
    const files = [];
    let total = 0;
    for (const e of tree.entries) {
      total += e.size;
      if (total > 512 * 1024 * 1024)
        throw new UserError("Linux bundles larger than 512 MB are not supported.");
      files.push({
        path: e.path,
        data: await tree.read(e.path),
        mode: e.path === scan.entry ? 0o755 : 0o644,
      });
    }
    await out.write("app/app.tar", writeTar(files));

    const xtermSpec = VENDORED.xterm;
    let xtermBase: string;
    let xtermDelivery: "vendored" | "cdn" = "vendored";
    if (options.runtime === "cdn" && xtermSpec.cdn?.base) {
      xtermBase = xtermSpec.cdn.base;
      xtermDelivery = "cdn";
    } else {
      xtermBase = await out.addRuntime(await ctx.runtimes.ensure("xterm"));
    }

    const dir = posixDirname(scan.entry);
    const program = posixBasename(scan.entry);
    const args = options.args.map(shellQuote).join(" ");
    const script = [
      "set -e",
      'mkdir -p "$HOME/app"',
      'tar -xf /data/app.tar -C "$HOME/app"',
      `cd "$HOME/app"${dir ? `/${shellQuote(dir)}` : ""}`,
      `chmod +x ${shellQuote(program)}`,
      `exec ./${shellQuote(program)}${args ? ` ${args}` : ""}`,
    ].join("\n");
    const cx = CDN.cheerpx;
    const data = {
      cheerpx: cx.url,
      disk: CHEERPX_DEBIAN_DISK,
      xterm: xtermBase,
      store: `waa-${options.slug}`,
      archive: "app/app.tar",
      script,
    };
    return {
      type: "static",
      runtimes: [runtimeRef(cx, "cdn", cx.url), runtimeRef(xtermSpec, xtermDelivery, xtermBase)],
      requirements: {
        crossOriginIsolation: true,
        network: [
          "cxrtnc.leaningtech.com",
          "disks.webvm.io",
          ...(xtermDelivery === "cdn" ? ["cdn.jsdelivr.net"] : []),
        ],
      },
      notices: [cx.notice],
      warnings: [cx.notice],
      page: {
        title: options.title,
        autostart: options.autostart,
        head: `<link rel="stylesheet" href="${xtermBase}xterm.css">\n<style>#term{position:absolute;inset:0;padding:8px;background:#000}</style>`,
        stage: `<div id="term"></div>`,
        data,
        boot: `
const { data } = WAA.config;
try {
  await WAA.start();
  WAA.status("Loading terminal…");
  await WAA.loadScript(new URL(data.xterm + "xterm.js", location.href).href);
  await WAA.loadScript(new URL(data.xterm + "addon-fit.js", location.href).href);
  const term = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 14, theme: { background: "#000000" } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));
  fit.fit();
  WAA.status("Loading Linux runtime…");
  const CheerpX = await import(data.cheerpx);
  WAA.status("Connecting to the Debian disk…");
  const cloud = await CheerpX.CloudDevice.create(data.disk);
  const cache = await CheerpX.IDBDevice.create(data.store);
  const root = await CheerpX.OverlayDevice.create(cloud, cache);
  const files = await CheerpX.DataDevice.create();
  const cx = await CheerpX.Linux.create({
    mounts: [
      { type: "ext2", path: "/", dev: root },
      { type: "dir", path: "/data", dev: files },
      { type: "devs", path: "/dev" },
      { type: "devpts", path: "/dev/pts" },
      { type: "proc", path: "/proc" },
    ],
  });
  const send = cx.setCustomConsole((buf, vt) => { if (vt === 1) term.write(buf); }, term.cols, term.rows);
  term.onData((s) => { for (const ch of s) send(ch.charCodeAt(0)); });
  addEventListener("resize", () => fit.fit());
  const archive = await WAA.fetchWithProgress(data.archive, "Downloading program");
  await files.writeFile("/app.tar", archive);
  WAA.ready();
  term.focus();
  term.write("\x1b[2mStarting… the first run streams parts of a Debian disk image and can take a minute.\x1b[0m\r\n");
  for (;;) {
    const result = await cx.run("/bin/sh", ["-c", data.script], {
      env: ["HOME=/home/user", "USER=user", "TERM=xterm-256color", "LANG=C.UTF-8", "PATH=/usr/local/bin:/usr/bin:/bin"],
      cwd: "/home/user",
      uid: 1000,
      gid: 1000,
    });
    term.write("\\r\\n\\x1b[2m[exited with status " + (result && result.status) + " — press any key to run again]\\x1b[0m\\r\\n");
    await new Promise((resolve) => { const d = term.onData(() => { d.dispose(); resolve(); }); });
  }
} catch (err) {
  WAA.fail(err);
}
`,
      },
    };
  },
};
