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

    const memory = options.disk.memoryMB ?? (scan.disk.type === "floppy" ? 32 : 128);
    return v86Output(ctx, {
      image,
      size,
      slot: scan.disk.type === "iso" ? "cdrom" : scan.disk.type === "floppy" ? "fda" : "hda",
      memoryMB: memory,
    });
  },
};

export interface V86Disk {
  /** Bundle path of the boot image. */
  image: string;
  size: number;
  slot: "fda" | "hda" | "cdrom";
  /** Optional CD-ROM image attached next to a hard disk (bundle path). */
  cdrom?: string;
  memoryMB: number;
  notices?: string[];
}

/** The v86 page for an image already copied into the bundle. Shared with the guest backend. */
export async function v86Output(ctx: BuildContext, disk: V86Disk): Promise<BuildOutput> {
  const { out, options } = ctx;
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
  const data = {
    lib: libBase,
    bios: biosBase,
    image: disk.image,
    size: disk.size,
    stream: disk.size > STREAM_THRESHOLD,
    slot: disk.slot,
    cdrom: disk.cdrom,
    memory: disk.memoryMB * 1024 * 1024,
  };
  return {
    type: "static",
    runtimes: [runtimeRef(spec, delivery, libBase, `https://github.com/copy/v86/tree/${V86_COMMIT}`)],
    requirements: { crossOriginIsolation: false, network: delivery === "cdn" ? ["cdn.jsdelivr.net"] : [] },
    notices: disk.notices ?? [],
    warnings: [],
    page: {
      title: options.title,
      autostart: options.autostart,
      head: `<style>
#screen_container{outline:none;display:flex;align-items:center;justify-content:center;width:100%;height:100%}
#screen_container > div{white-space:pre;font:14px/14px monospace;color:#ccc}
#screen_container canvas{image-rendering:pixelated;max-width:100%;max-height:100%}
</style>`,
      stage: `<div id="screen_container" tabindex="0"><div></div><canvas style="display:none"></canvas></div>`,
      data,
      boot: `
const { data } = WAA.config;
let emulator = null;
const snapshot = async () => new Uint8Array(await emulator.save_state());
// The whole machine (RAM, CPU, devices) is the save: the PC resumes exactly where it was.
WAA.saves.register({
  async capture() {
    if (emulator) {
      const state = await snapshot();
      await WAA.saves.local.write(state, { fromSync: true });
      return state;
    }
    const saved = await WAA.saves.local.read();
    return saved ? saved.bytes : null;
  },
  restore: (bytes) => WAA.saves.local.write(bytes, { fromSync: true }),
  clear: () => WAA.saves.local.clear(),
  flush: async () => {
    if (emulator) await WAA.saves.local.write(await snapshot(), { fromSync: true });
  },
});
try {
  await WAA.start();
  WAA.status("Loading PC emulator…");
  await WAA.loadScript(new URL(data.lib + "libv86.js", location.href).href);
  const image = { url: new URL(data.image, location.href).href };
  if (data.stream) Object.assign(image, { async: true, size: data.size });
  const options = {
    wasm_path: new URL(data.lib + "v86.wasm", location.href).href,
    memory_size: data.memory,
    vga_memory_size: 8 * 1024 * 1024,
    screen_container: document.getElementById("screen_container"),
    bios: { url: new URL(data.bios + "seabios.bin", location.href).href },
    vga_bios: { url: new URL(data.bios + "vgabios.bin", location.href).href },
    [data.slot]: image,
    autostart: true,
  };
  // A guest OS on the hard disk sees the program as a CD-ROM (the BIOS still boots the disk first).
  if (data.cdrom) options.cdrom = { url: new URL(data.cdrom, location.href).href };
  const saved = await WAA.saves.local.read();
  if (saved) {
    WAA.status("Restoring saved state…");
    const b = saved.bytes;
    options.initial_state = { buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
  emulator = new V86(options);
  emulator.add_listener("download-progress", (e) => {
    if (e.lengthComputable && e.total) {
      WAA.progress(e.loaded / e.total);
      WAA.status("Downloading " + (e.file_name || "disk") + "…");
    }
  });
  emulator.add_listener("emulator-ready", () => {
    WAA.ready();
    document.getElementById("screen_container").focus({ preventScroll: true });
  });
  window.waaEmulator = emulator;
} catch (err) {
  WAA.fail(err);
}
`,
    },
  };
}
