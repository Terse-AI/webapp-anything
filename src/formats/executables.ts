import { Reader } from "../util/bytes.js";

export type Arch =
  | "x86"
  | "x86_64"
  | "arm"
  | "arm64"
  | "ia64"
  | "ppc"
  | "ppc64"
  | "riscv"
  | "mips"
  | "unknown";

export interface DosInfo {
  format: "dos";
  /** Uses a DOS extender such as DOS/4GW (LE executables). */
  extended: boolean;
  extender?: string;
}

export interface NeInfo {
  format: "ne";
  targetOs: "windows" | "os2" | "dos4" | "win386" | "unknown";
}

export interface LeInfo {
  format: "le" | "lx";
  extender?: string;
}

export interface PeInfo {
  format: "pe";
  arch: Arch;
  bits: 32 | 64;
  subsystem: "gui" | "console" | "native" | "efi" | "wince" | "other";
  dll: boolean;
  dotnet: boolean;
  imports: string[];
  installer?: "inno" | "nsis" | "installshield" | "msi-wrapper" | "wix";
}

export interface ElfInfo {
  format: "elf";
  arch: Arch;
  bits: 32 | 64;
  endian: "le" | "be";
  type: "exec" | "dyn" | "rel" | "core" | "other";
  interpreter?: string;
  staticallyLinked: boolean;
  needed: string[];
  gui: boolean;
}

export interface MachOInfo {
  format: "macho";
  arches: Arch[];
  fat: boolean;
}

export type ExecutableInfo = DosInfo | NeInfo | LeInfo | PeInfo | ElfInfo | MachOInfo;

const PE_MACHINES: Record<number, Arch> = {
  332: "x86",
  34404: "x86_64",
  43620: "arm64",
  448: "arm",
  452: "arm",
  512: "ia64",
};

const ELF_MACHINES: Record<number, Arch> = {
  3: "x86",
  62: "x86_64",
  40: "arm",
  183: "arm64",
  243: "riscv",
  8: "mips",
  20: "ppc",
  21: "ppc64",
};

const MACHO_CPU: Record<number, Arch> = {
  7: "x86",
  16777223: "x86_64",
  12: "arm",
  16777228: "arm64",
  33554444: "arm64",
  18: "ppc",
  16777234: "ppc64",
};

function includesAscii(bytes: Uint8Array, needle: string, limit = bytes.length): boolean {
  const n = needle.length;
  const first = needle.charCodeAt(0);
  const end = Math.min(bytes.length, limit) - n;
  outer: for (let i = 0; i <= end; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

function detectExtender(bytes: Uint8Array): string | undefined {
  const window = Math.min(bytes.length, 512 * 1024);
  if (includesAscii(bytes, "DOS/4G", window)) return "DOS/4GW";
  if (includesAscii(bytes, "DOS/32A", window)) return "DOS/32A";
  if (includesAscii(bytes, "PMODE/W", window)) return "PMODE/W";
  if (includesAscii(bytes, "CWSDPMI", window) || includesAscii(bytes, "go32", window)) return "DJGPP";
  if (includesAscii(bytes, "PHARLAP", window) || includesAscii(bytes, "Phar Lap", window)) return "Phar Lap";
  return undefined;
}

export function parseMz(bytes: Uint8Array): DosInfo | NeInfo | LeInfo | PeInfo | undefined {
  const r = new Reader(bytes);
  if (!(r.ascii(0, 2) === "MZ" || r.ascii(0, 2) === "ZM")) return undefined;
  // Plain DOS programs may have garbage at e_lfanew, so trust it only if a known signature is there.
  const lfanew = r.u32(0x3c);
  if (lfanew !== undefined && lfanew >= 0x40 && lfanew < bytes.length - 4) {
    const sig2 = r.ascii(lfanew, 2);
    if (r.ascii(lfanew, 4) === "PE\0\0") return parsePe(r, lfanew);
    if (sig2 === "NE") {
      const os = r.u8(lfanew + 0x36);
      const targetOs =
        os === 2 ? "windows" : os === 1 ? "os2" : os === 3 ? "dos4" : os === 4 ? "win386" : "unknown";
      return { format: "ne", targetOs };
    }
    if (sig2 === "LE" || sig2 === "LX") {
      return { format: sig2 === "LE" ? "le" : "lx", extender: detectExtender(bytes) };
    }
  }
  const extender = detectExtender(bytes);
  return { format: "dos", extended: extender !== undefined, extender };
}

function parsePe(r: Reader, lfanew: number): PeInfo {
  const coff = lfanew + 4;
  const machine = r.u16(coff) ?? 0;
  const numSections = r.u16(coff + 2) ?? 0;
  const optSize = r.u16(coff + 16) ?? 0;
  const characteristics = r.u16(coff + 18) ?? 0;
  const opt = coff + 20;
  const magic = r.u16(opt);
  const pe32plus = magic === 0x20b;
  const subsystemCode = r.u16(opt + 68) ?? 0;
  const numDirs = r.u32(opt + (pe32plus ? 108 : 92)) ?? 0;
  const dirBase = opt + (pe32plus ? 112 : 96);
  const dir = (i: number) =>
    i < numDirs ? { rva: r.u32(dirBase + i * 8) ?? 0, size: r.u32(dirBase + i * 8 + 4) ?? 0 } : undefined;

  const sections: { va: number; vsize: number; raw: number; rawSize: number }[] = [];
  const secTable = opt + optSize;
  for (let i = 0; i < Math.min(numSections, 96); i++) {
    const s = secTable + i * 40;
    if (!r.has(s, 40)) break;
    sections.push({ vsize: r.u32(s + 8)!, va: r.u32(s + 12)!, rawSize: r.u32(s + 16)!, raw: r.u32(s + 20)! });
  }
  const rvaToOffset = (rva: number): number | undefined => {
    for (const s of sections) {
      const span = Math.max(s.vsize, s.rawSize);
      if (rva >= s.va && rva < s.va + span) return rva - s.va + s.raw;
    }
    return undefined;
  };

  const imports: string[] = [];
  const importDir = dir(1);
  if (importDir?.rva) {
    let off = rvaToOffset(importDir.rva);
    for (let i = 0; off !== undefined && i < 512 && r.has(off, 20); i++, off += 20) {
      const nameRva = r.u32(off + 12) ?? 0;
      const firstThunk = r.u32(off + 16) ?? 0;
      if (nameRva === 0 && firstThunk === 0) break;
      const nameOff = rvaToOffset(nameRva);
      if (nameOff !== undefined) {
        const name = r.cstring(nameOff, 256).toLowerCase();
        if (name && /^[\x20-\x7e]+$/.test(name)) imports.push(name);
      }
    }
  }
  const clr = dir(14);
  const subsystem: PeInfo["subsystem"] =
    subsystemCode === 2
      ? "gui"
      : subsystemCode === 3
        ? "console"
        : subsystemCode === 1
          ? "native"
          : subsystemCode === 9
            ? "wince"
            : subsystemCode >= 10 && subsystemCode <= 13
              ? "efi"
              : "other";

  const window = Math.min(r.length, 8 * 1024 * 1024);
  let installer: PeInfo["installer"];
  if (includesAscii(r.bytes, "Inno Setup", window)) installer = "inno";
  else if (includesAscii(r.bytes, "Nullsoft", window) || includesAscii(r.bytes, "NullsoftInst", window))
    installer = "nsis";
  else if (includesAscii(r.bytes, "InstallShield", window)) installer = "installshield";
  else if (includesAscii(r.bytes, "WixBurn", window) || includesAscii(r.bytes, ".wixburn", window))
    installer = "wix";

  return {
    format: "pe",
    arch: PE_MACHINES[machine] ?? "unknown",
    bits: pe32plus ? 64 : 32,
    subsystem,
    dll: (characteristics & 0x2000) !== 0,
    dotnet: !!clr && clr.rva !== 0 && clr.size !== 0,
    imports,
    installer,
  };
}

const GUI_LIBS =
  /^(libx11|libxcb|libwayland-client|libgtk|libgdk|libqt\d?|libsdl|libgl\.|libglfw|libegl|libvulkan|libfltk|libwx_)/;

export function parseElf(bytes: Uint8Array): ElfInfo | undefined {
  const r = new Reader(bytes);
  if (!r.startsWith([0x7f, 0x45, 0x4c, 0x46])) return undefined;
  const cls = r.u8(4);
  const data = r.u8(5);
  const le = data !== 2;
  const bits: 32 | 64 = cls === 2 ? 64 : 32;
  const etype = r.u16(16, le) ?? 0;
  const machine = r.u16(18, le) ?? 0;
  const phoff = bits === 64 ? r.u64(32, le) : r.u32(28, le);
  const phentsize = r.u16(bits === 64 ? 54 : 42, le) ?? 0;
  const phnum = r.u16(bits === 64 ? 56 : 44, le) ?? 0;

  type Ph = { type: number; offset: number; vaddr: number; filesz: number };
  const phs: Ph[] = [];
  if (phoff !== undefined && phentsize > 0) {
    for (let i = 0; i < Math.min(phnum, 256); i++) {
      const b = phoff + i * phentsize;
      if (!r.has(b, bits === 64 ? 56 : 32)) break;
      if (bits === 64) {
        phs.push({
          type: r.u32(b, le)!,
          offset: r.u64(b + 8, le) ?? 0,
          vaddr: r.u64(b + 16, le) ?? 0,
          filesz: r.u64(b + 32, le) ?? 0,
        });
      } else {
        phs.push({
          type: r.u32(b, le)!,
          offset: r.u32(b + 4, le)!,
          vaddr: r.u32(b + 8, le)!,
          filesz: r.u32(b + 16, le)!,
        });
      }
    }
  }
  let interpreter: string | undefined;
  const interp = phs.find((p) => p.type === 3);
  if (interp) interpreter = r.cstring(interp.offset, Math.min(interp.filesz, 512)) || undefined;

  const needed: string[] = [];
  const dyn = phs.find((p) => p.type === 2);
  if (dyn) {
    const entSize = bits === 64 ? 16 : 8;
    const tags: { tag: number; val: number }[] = [];
    for (let o = dyn.offset; o + entSize <= dyn.offset + dyn.filesz && tags.length < 4096; o += entSize) {
      const tag = bits === 64 ? (r.u64(o, le) ?? -1) : (r.u32(o, le) ?? -1);
      const val = bits === 64 ? (r.u64(o + 8, le) ?? 0) : (r.u32(o + 4, le) ?? 0);
      if (tag === 0) break;
      tags.push({ tag, val });
    }
    const strtabVaddr = tags.find((t) => t.tag === 5)?.val;
    const loads = phs.filter((p) => p.type === 1);
    const strtabOff =
      strtabVaddr === undefined
        ? undefined
        : loads
            .map((l) =>
              strtabVaddr >= l.vaddr && strtabVaddr < l.vaddr + l.filesz
                ? strtabVaddr - l.vaddr + l.offset
                : undefined,
            )
            .find((x) => x !== undefined);
    if (strtabOff !== undefined) {
      for (const t of tags) if (t.tag === 1) needed.push(r.cstring(strtabOff + t.val, 256));
    }
  }
  const type: ElfInfo["type"] =
    etype === 2 ? "exec" : etype === 3 ? "dyn" : etype === 1 ? "rel" : etype === 4 ? "core" : "other";
  return {
    format: "elf",
    arch: ELF_MACHINES[machine] ?? "unknown",
    bits,
    endian: le ? "le" : "be",
    type,
    interpreter,
    staticallyLinked: !interpreter && !dyn,
    needed,
    gui: needed.some((n) => GUI_LIBS.test(n.toLowerCase())),
  };
}

export function parseMachO(bytes: Uint8Array): MachOInfo | undefined {
  const r = new Reader(bytes);
  const be = r.u32(0, false);
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const n = r.u32(4, false) ?? 0;
    // 0xCAFEBABE is shared with Java class files; their "count" is the class-file version (>= 45).
    if (n === 0 || n >= 40) return undefined;
    const size = be === 0xcafebabf ? 32 : 20;
    const arches: Arch[] = [];
    for (let i = 0; i < n; i++) {
      const cpu = r.u32(8 + i * size, false);
      if (cpu === undefined) break;
      arches.push(MACHO_CPU[cpu] ?? "unknown");
    }
    return { format: "macho", arches, fat: true };
  }
  const leMagic = r.u32(0, true);
  if (leMagic === 0xfeedface || leMagic === 0xfeedfacf) {
    return { format: "macho", arches: [MACHO_CPU[r.u32(4, true) ?? 0] ?? "unknown"], fat: false };
  }
  if (be === 0xfeedface || be === 0xfeedfacf) {
    return { format: "macho", arches: [MACHO_CPU[r.u32(4, false) ?? 0] ?? "unknown"], fat: false };
  }
  return undefined;
}

export function parseExecutable(bytes: Uint8Array): ExecutableInfo | undefined {
  return parseMz(bytes) ?? parseElf(bytes) ?? parseMachO(bytes);
}

export function describeExecutable(info: ExecutableInfo): string {
  switch (info.format) {
    case "dos":
      return info.extended ? `DOS program (${info.extender} extender)` : "DOS program";
    case "ne":
      return info.targetOs === "windows"
        ? "16-bit Windows program (NE)"
        : `16-bit ${info.targetOs} program (NE)`;
    case "le":
    case "lx":
      return info.extender
        ? `32-bit DOS program (${info.extender})`
        : `${info.format.toUpperCase()} executable`;
    case "pe": {
      const kind = info.dotnet ? ".NET assembly" : info.dll ? "Windows DLL" : "Windows program";
      return `${kind} (${info.bits}-bit ${info.arch}, ${info.subsystem})${info.installer ? `, ${info.installer} installer` : ""}`;
    }
    case "elf":
      return `Linux ${info.type === "dyn" && !info.interpreter ? "shared object" : "program"} (${info.bits}-bit ${info.arch}, ${
        info.staticallyLinked ? "static" : "dynamic"
      }${info.gui ? ", GUI" : ""})`;
    case "macho":
      return `macOS program (${info.arches.join(" + ")})`;
  }
}
