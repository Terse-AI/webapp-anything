import { runtimeRef } from "../build/bundle.js";
import { V86_COMMIT, VENDORED } from "../runtimes/registry.js";
import { UserError } from "../util/errors.js";
import { extname } from "../util/paths.js";
import type { Backend, BuildContext, BuildOutput } from "./types.js";

/** Images above this size are streamed with HTTP range requests instead of downloaded up front. */
const STREAM_THRESHOLD = 64 * 1024 * 1024;

export const diskBackend: Backend = {
  id: "disk",
  title: "PC emulator (v86)",
  description: "A full x86 PC (BIOS, VGA, disks) emulated in WebAssembly with a JIT.",
  runs: "Bootable CD-ROM (.iso), floppy and hard-disk images: DOS, Windows 9x, Linux, KolibriOS…",
  assess(scan) {
    if (scan.kind !== "disk-image" || !scan.disk) return undefined;
    const bootable = scan.disk.bootable;
    return {
      backend: "disk",
      score: bootable ? 90 : 35,
      stability: "stable",
      reasons: [`Boots the ${scan.disk.type} image in an emulated PC.`],
      warnings: bootable
        ? []
        : ["The image is not marked bootable; the emulator may show “No bootable device”."],
    };
  },
  async build(ctx: BuildContext): Promise<BuildOutput> {
    const { scan, tree, out, options } = ctx;
    if (!scan.entry || !scan.disk) throw new UserError("No disk image to boot.");
    const size = tree.size(scan.entry) ?? 0;
    const ext = extname(scan.entry) || (scan.disk.type === "iso" ? ".iso" : ".img");
    const image = `app/disk${ext}`;
    await out.copyFromTree(tree, scan.entry, image);

    const spec = VENDORED.v86;
    let libBase: string;
    let biosBase: string;
    let delivery: "vendored" | "cdn" = "vendored";
    if (options.runtime === "cdn" && spec.cdn?.base && spec.cdn.bios) {
      libBase = `${spec.cdn.base}build/`;
      biosBase = spec.cdn.bios;
      delivery = "cdn";
    } else {
      const base = await out.addRuntime(await ctx.runtimes.ensure("v86"));
      libBase = `${base}build/`;
      biosBase = `${base}bios/`;
    }
    const memory = options.disk.memoryMB ?? (scan.disk.type === "floppy" ? 32 : 128);
    const data = {
      lib: libBase,
      bios: biosBase,
      image,
      size,
      stream: size > STREAM_THRESHOLD,
      slot: scan.disk.type === "iso" ? "cdrom" : scan.disk.type === "floppy" ? "fda" : "hda",
      memory: memory * 1024 * 1024,
    };
    return {
      type: "static",
      runtimes: [runtimeRef(spec, delivery, libBase, `https://github.com/copy/v86/tree/${V86_COMMIT}`)],
      requirements: { crossOriginIsolation: false, network: delivery === "cdn" ? ["cdn.jsdelivr.net"] : [] },
      notices: [],
      warnings: [],
      page: {
        title: options.title,
        autostart: options.autostart,
        head: `<style>
#screen_container{display:flex;align-items:center;justify-content:center;width:100%;height:100%}
#screen_container > div{white-space:pre;font:14px/14px monospace;color:#ccc}
#screen_container canvas{image-rendering:pixelated;max-width:100%;max-height:100%}
</style>`,
        stage: `<div id="screen_container" tabindex="0"><div></div><canvas style="display:none"></canvas></div>`,
        data,
        boot: `
const { data } = WAA.config;
try {
  await WAA.start();
  WAA.status("Loading PC emulator…");
  await WAA.loadScript(new URL(data.lib + "libv86.js", location.href).href);
  const image = { url: new URL(data.image, location.href).href };
  if (data.stream) Object.assign(image, { async: true, size: data.size });
  const emulator = new V86({
    wasm_path: new URL(data.lib + "v86.wasm", location.href).href,
    memory_size: data.memory,
    vga_memory_size: 8 * 1024 * 1024,
    screen_container: document.getElementById("screen_container"),
    bios: { url: new URL(data.bios + "seabios.bin", location.href).href },
    vga_bios: { url: new URL(data.bios + "vgabios.bin", location.href).href },
    [data.slot]: image,
    autostart: true,
  });
  emulator.add_listener("download-progress", (e) => {
    if (e.lengthComputable && e.total) {
      WAA.progress(e.loaded / e.total);
      WAA.status("Downloading " + (e.file_name || "disk") + "…");
    }
  });
  emulator.add_listener("emulator-ready", () => {
    WAA.ready();
    document.getElementById("screen_container").focus();
  });
  window.waaEmulator = emulator;
} catch (err) {
  WAA.fail(err);
}
`,
      },
    };
  },
};
