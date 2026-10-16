import { readFile, stat } from "node:fs/promises";
import { zipSync } from "fflate";
import { buildIso } from "../formats/iso.js";
import { parseDiskImage } from "../formats/media.js";
import { fileSource } from "../util/bytes.js";
import { UserError } from "../util/errors.js";
import { extname, posixBasename } from "../util/paths.js";
import { v86Output } from "./disk.js";
import { jsdosOutput } from "./dos.js";
import type { Backend, BuildContext, BuildOutput } from "./types.js";

/** Bundles above this size must use v86, which streams disks; DOSBox-X loads the whole bundle into memory. */
const DOSBOX_X_LIMIT = 1024 * 1024 * 1024;

export interface GuestImageInfo {
  size: number;
  /** The MBR holds at least one partition (normal for installed Windows 9x disks). */
  partitioned: boolean;
}

export async function inspectGuestImage(file: string): Promise<GuestImageInfo> {
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) throw new UserError(`Guest image not found: ${file}`);
  const src = await fileSource(file);
  try {
    const head = await src.read(0, 72 * 1024);
    const disk = parseDiskImage(head, st.size, extname(file) || ".img");
    if (disk?.type !== "hdd") {
      throw new UserError(
        `${posixBasename(file)} is not a hard-disk image.`,
        disk?.type === "iso" || disk?.type === "floppy"
          ? `Boot ${disk.type === "iso" ? "CD" : "floppy"} images directly with "waa build ${posixBasename(file)}".`
          : "Use a raw .img/.hdd of an installed Windows 9x (or DOS) system.",
      );
    }
    let partitioned = false;
    for (let i = 0; i < 4; i++) {
      const entry = head.subarray(446 + i * 16, 462 + i * 16);
      if (entry[4] !== 0 && entry.some((b) => b !== 0)) partitioned = true;
    }
    return { size: st.size, partitioned };
  } finally {
    await src.close();
  }
}

/**
 * DOSBox-X: attach the guest disk by BIOS number and the program as an IDE CD-ROM (so the booted
 * OS sees it with its own CD driver, not just DOS through MSCDEX), then boot the disk.
 */
export function guestDosboxConf(guest: GuestImageInfo, memoryMB: number): string {
  // Unpartitioned images need an explicit geometry (63 sectors, 16 heads).
  const geometry = guest.partitioned
    ? ""
    : ` -size 512,63,16,${Math.max(1, Math.floor(guest.size / (512 * 63 * 16)))}`;
  return [
    "[sdl]",
    "autolock=false",
    "",
    "[dosbox]",
    "machine=svga_s3",
    `memsize=${memoryMB}`,
    "",
    "[cpu]",
    "core=normal",
    "cputype=pentium_mmx",
    "cycles=max",
    "",
    "[ide, primary]",
    "enable=true",
    "",
    "[ide, secondary]",
    "enable=true",
    "",
    "[autoexec]",
    `imgmount 2 guest.img -t hdd -fs none${geometry}`,
    "imgmount d app.iso -t iso -ide 2m",
    "boot -l c",
    "",
  ].join("\r\n");
}

export const guestBackend: Backend = {
  id: "guest",
  title: "Guest OS (v86 or DOSBox-X)",
  description:
    "Boots a disk image you supply (for example an installed Windows 98) and gives it the program on a CD-ROM drive.",
  runs: "Anything that runs on the guest OS you provide (Windows 9x programs, including DirectX/3dfx games under DOSBox-X)",
  // Only chosen explicitly with --guest; never picked by the planner.
  assess: () => undefined,
  async build(ctx: BuildContext): Promise<BuildOutput> {
    const { tree, out, options } = ctx;
    const guestFile = options.guest?.image;
    if (!guestFile) throw new UserError("The guest backend needs --guest <disk image>.");
    const guest = await inspectGuestImage(guestFile);
    const engine = options.guest?.engine ?? "v86";
    const memoryMB = options.disk.memoryMB ?? 128;

    // The program (and its folder) becomes a CD-ROM the guest reads as drive D:.
    const files = [];
    for (const e of tree.entries) files.push({ path: e.path, data: await tree.read(e.path) });
    const iso = buildIso(
      files,
      posixBasename(tree.name)
        .replace(/\.[^.]+$/, "")
        .slice(0, 32) || "APP",
    );
    const notices = [
      "The guest operating system image was supplied by whoever built this app; its own license terms apply.",
      `The program is on the CD-ROM drive (D:) inside the guest.`,
    ];

    if (engine === "dosboxX") {
      const total = guest.size + iso.byteLength;
      if (total > DOSBOX_X_LIMIT) {
        throw new UserError(
          `The guest image is ${Math.round(guest.size / 1048576)} MB; DOSBox-X loads it fully into memory.`,
          "Use --guest-engine v86, which streams large disks, or shrink the image.",
        );
      }
      const bundle = zipSync(
        {
          "guest.img": [new Uint8Array(await readFile(guestFile)), { level: 0 }],
          "app.iso": [iso, { level: 0 }],
          ".jsdos/dosbox.conf": new TextEncoder().encode(guestDosboxConf(guest, Math.min(memoryMB, 512))),
        },
        { level: 6 },
      );
      await out.write("app/guest.jsdos", bundle);
      return jsdosOutput(
        ctx,
        "app/guest.jsdos",
        "dosboxX",
        [
          "Progress inside the guest is not saved between visits with DOSBox-X; use --guest-engine v86 for machine-state saves.",
        ],
        notices,
        false,
      );
    }

    await out.copyFile(guestFile, "app/guest.img");
    await out.write("app/app.iso", iso);
    return v86Output(ctx, {
      image: "app/guest.img",
      size: guest.size,
      slot: "hda",
      cdrom: "app/app.iso",
      memoryMB,
      notices,
    });
  },
};
