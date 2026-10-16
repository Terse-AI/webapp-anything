// Tiny, hand-assembled sample programs and file-format fixtures.
// Used by the unit tests and by `npm run examples`. Everything here is generated, so no
// third-party binaries live in the repository.
import { zipSync } from "fflate";

const enc = new TextEncoder();

function u16(v) {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}
function bytes(...parts) {
  const flat = parts.flatMap((p) =>
    typeof p === "string" ? [...enc.encode(p)] : p instanceof Uint8Array ? [...p] : p,
  );
  return Uint8Array.from(flat);
}

// ---------------------------------------------------------------------------
// DOS .COM: prints a message, waits for a key, exits.
export function dosCom(
  message = "Hello from webapp-anything!\r\nThis DOS program is running in your browser.\r\n\r\nPress any key to exit.",
) {
  const code = [
    0xb4,
    0x09, // mov ah, 9
    0xba,
    0x10,
    0x01, // mov dx, 0x0110
    0xcd,
    0x21, // int 21h
    0xb4,
    0x00, // mov ah, 0
    0xcd,
    0x16, // int 16h (wait for key)
    0xb8,
    0x00,
    0x4c, // mov ax, 4C00h
    0xcd,
    0x21, // int 21h
  ];
  return bytes(code, `${message}$`);
}

/** Minimal MZ header for a DOS .EXE (optionally with a DOS/4GW marker string). */
export function dosExe({ extender = false } = {}) {
  const header = new Uint8Array(512);
  header.set(bytes("MZ"), 0);
  header.set(u16(512 % 512), 2);
  header.set(u16(2), 4);
  header.set(u16(0), 6);
  header.set(u16(32), 8); // header paragraphs
  header.set(u16(0x1c), 0x18);
  const body = new Uint8Array(512);
  body.set([0xb8, 0x00, 0x4c, 0xcd, 0x21], 0);
  if (extender) body.set(bytes("DOS/4G Protected Mode Run-time"), 64);
  return bytes(header, body);
}

// ---------------------------------------------------------------------------
// Bootable 1.44 MB floppy that prints a message from the boot sector.
export function bootFloppy(
  message = "Hello from webapp-anything!\r\nThis PC booted from a floppy image in your browser.",
) {
  const code = [
    0xfa, // cli
    0x31,
    0xc0, // xor ax, ax
    0x8e,
    0xd8, // mov ds, ax
    0x8e,
    0xd0, // mov ss, ax
    0xbc,
    0x00,
    0x7c, // mov sp, 7C00h
    0xfb, // sti
    0xbe,
    0x1c,
    0x7c, // mov si, msg
    0xb4,
    0x0e, // .loop: mov ah, 0Eh
    0xac, // lodsb
    0x08,
    0xc0, // or al, al
    0x74,
    0x04, // jz .done
    0xcd,
    0x10, // int 10h
    0xeb,
    0xf5, // jmp .loop
    0xf4, // .done: hlt
    0xeb,
    0xfd, // jmp .done
  ];
  const sector = new Uint8Array(512);
  sector.set(code, 0);
  sector.set(bytes(message, [0]), code.length);
  sector[510] = 0x55;
  sector[511] = 0xaa;
  const disk = new Uint8Array(1474560);
  disk.set(sector, 0);
  return disk;
}

// ---------------------------------------------------------------------------
// Static 32-bit x86 Linux ELF: asks for a name and greets it.
/**
 * An unpartitioned 8 MB hard disk (16 cylinders, 16 heads, 63 sectors). It prints `message` at
 * boot, or with `fill` switches to VGA mode 13h and paints the screen that palette colour.
 */
export function bootDisk(message = "Guest disk booted.", { fill } = {}) {
  let sector = bootFloppy(message).subarray(0, 512);
  if (fill !== undefined) {
    sector = new Uint8Array(512);
    sector.set([
      0xb8,
      0x13,
      0x00, // mov ax, 0013h
      0xcd,
      0x10, // int 10h
      0xb8,
      0x00,
      0xa0, // mov ax, 0A000h
      0x8e,
      0xc0, // mov es, ax
      0x31,
      0xff, // xor di, di
      0xb0,
      fill, // mov al, fill
      0xb9,
      0x00,
      0xfa, // mov cx, 64000
      0xfc, // cld
      0xf3,
      0xaa, // rep stosb
      0xf4, // .done: hlt
      0xeb,
      0xfd, // jmp .done
    ]);
    sector[510] = 0x55;
    sector[511] = 0xaa;
  }
  const disk = new Uint8Array(16 * 16 * 63 * 512);
  disk.set(sector, 0);
  return disk;
}

export function linuxHello() {
  const base = 0x08048000;
  const codeOff = 84;
  const prompt = "What's your name? ";
  const hello = "Hello, ";
  const bye = "Greetings from a Linux binary running in your browser.\n";
  const movEax = (v) => [0xb8, ...u32(v)];
  const movEbx = (v) => [0xbb, ...u32(v)];
  const movEcx = (v) => [0xb9, ...u32(v)];
  const movEdx = (v) => [0xba, ...u32(v)];
  const int80 = [0xcd, 0x80];
  const assemble = (addr) => [
    ...movEax(4),
    ...movEbx(1),
    ...movEcx(addr.prompt),
    ...movEdx(prompt.length),
    ...int80,
    ...movEax(3),
    0x31,
    0xdb,
    ...movEcx(addr.buf),
    ...movEdx(64),
    ...int80,
    0x89,
    0xc6, // mov esi, eax
    ...movEax(4),
    ...movEbx(1),
    ...movEcx(addr.hello),
    ...movEdx(hello.length),
    ...int80,
    ...movEax(4),
    ...movEbx(1),
    ...movEcx(addr.buf),
    0x89,
    0xf2,
    ...int80,
    ...movEax(4),
    ...movEbx(1),
    ...movEcx(addr.bye),
    ...movEdx(bye.length),
    ...int80,
    ...movEax(1),
    0x31,
    0xdb,
    ...int80,
  ];
  const codeLen = assemble({ prompt: 0, buf: 0, hello: 0, bye: 0 }).length;
  const dataOff = codeOff + codeLen;
  const addr = {
    prompt: base + dataOff,
    hello: base + dataOff + prompt.length,
    bye: base + dataOff + prompt.length + hello.length,
  };
  const fileLen = dataOff + prompt.length + hello.length + bye.length;
  addr.buf = base + ((fileLen + 15) & ~15);
  const memLen = (fileLen + 15 + 64) & ~15;
  const ehdr = [
    0x7f,
    0x45,
    0x4c,
    0x46,
    1,
    1,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...u16(2),
    ...u16(3),
    ...u32(1),
    ...u32(base + codeOff),
    ...u32(52),
    ...u32(0),
    ...u32(0),
    ...u16(52),
    ...u16(32),
    ...u16(1),
    ...u16(40),
    ...u16(0),
    ...u16(0),
  ];
  const phdr = [
    ...u32(1),
    ...u32(0),
    ...u32(base),
    ...u32(base),
    ...u32(fileLen),
    ...u32(memLen),
    ...u32(7),
    ...u32(0x1000),
  ];
  return bytes(ehdr, phdr, assemble(addr), prompt, hello, bye);
}

/** ELF with PT_INTERP and DT_NEEDED entries (not runnable; for scanner tests). */
export function elfDynamic({
  bits = 64,
  machine = 0x3e,
  needed = ["libc.so.6"],
  interp = "/lib64/ld-linux-x86-64.so.2",
} = {}) {
  const is64 = bits === 64;
  const ehsize = is64 ? 64 : 52;
  const phentsize = is64 ? 56 : 32;
  const phnum = 3;
  const phoff = ehsize;
  const interpOff = phoff + phentsize * phnum;
  const interpBytes = bytes(interp, [0]);
  const strtabOff = interpOff + interpBytes.length;
  const strs = [0];
  const nameOffsets = needed.map((n) => {
    const off = strs.length;
    strs.push(...enc.encode(n), 0);
    return off;
  });
  const strtab = Uint8Array.from(strs);
  const dynOff = (strtabOff + strtab.length + 7) & ~7;
  const dynEntries = [...nameOffsets.map((o) => [1, o]), [5, strtabOff /* vaddr == offset */], [0, 0]];
  const dynSize = dynEntries.length * (is64 ? 16 : 8);
  const total = dynOff + dynSize;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1], 0);
  v.setUint16(16, 3, true);
  v.setUint16(18, machine, true);
  v.setUint32(20, 1, true);
  if (is64) {
    v.setBigUint64(32, BigInt(phoff), true);
    v.setUint16(52, ehsize, true);
    v.setUint16(54, phentsize, true);
    v.setUint16(56, phnum, true);
  } else {
    v.setUint32(28, phoff, true);
    v.setUint16(40, ehsize, true);
    v.setUint16(42, phentsize, true);
    v.setUint16(44, phnum, true);
  }
  const ph = (i, type, offset, size) => {
    const b = phoff + i * phentsize;
    v.setUint32(b, type, true);
    if (is64) {
      v.setBigUint64(b + 8, BigInt(offset), true);
      v.setBigUint64(b + 16, BigInt(offset), true);
      v.setBigUint64(b + 32, BigInt(size), true);
      v.setBigUint64(b + 40, BigInt(size), true);
    } else {
      v.setUint32(b + 4, offset, true);
      v.setUint32(b + 8, offset, true);
      v.setUint32(b + 16, size, true);
      v.setUint32(b + 20, size, true);
    }
  };
  ph(0, 3, interpOff, interpBytes.length);
  ph(1, 1, 0, total);
  ph(2, 2, dynOff, dynSize);
  out.set(interpBytes, interpOff);
  out.set(strtab, strtabOff);
  dynEntries.forEach(([tag, val], i) => {
    const b = dynOff + i * (is64 ? 16 : 8);
    if (is64) {
      v.setBigUint64(b, BigInt(tag), true);
      v.setBigUint64(b + 8, BigInt(val), true);
    } else {
      v.setUint32(b, tag, true);
      v.setUint32(b + 4, val, true);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// PE / NE / LE headers for scanner tests.
export function peExe({
  machine = 0x14c,
  subsystem = 2,
  dll = false,
  dotnet = false,
  imports = ["kernel32.dll", "user32.dll"],
  marker,
  resources,
} = {}) {
  const pe32plus = machine === 0x8664 || machine === 0xaa64;
  const lfanew = 0x80;
  const optSize = pe32plus ? 240 : 224;
  const secTable = lfanew + 24 + optSize;
  const fileAlign = 0x200;
  const secRaw = 0x400;
  const secRva = 0x1000;
  const rsrcRva = 0x2000;
  const rsrc = resources ? resourceSection(resources, rsrcRva) : undefined;
  const rsrcRaw = secRaw + 0x400;
  const rsrcSize = rsrc ? Math.ceil(rsrc.length / fileAlign) * fileAlign : 0;
  const size = secRaw + 0x400 + rsrcSize;
  const out = new Uint8Array(size + (marker ? 64 : 0));
  const v = new DataView(out.buffer);
  out.set(bytes("MZ"), 0);
  v.setUint16(0x18, 0x40, true);
  v.setUint32(0x3c, lfanew, true);
  out.set(bytes("PE\0\0"), lfanew);
  const coff = lfanew + 4;
  v.setUint16(coff, machine, true);
  v.setUint16(coff + 2, rsrc ? 2 : 1, true);
  v.setUint16(coff + 16, optSize, true);
  v.setUint16(coff + 18, 0x0102 | (dll ? 0x2000 : 0), true);
  const opt = coff + 20;
  v.setUint16(opt, pe32plus ? 0x20b : 0x10b, true);
  v.setUint32(opt + 32, 0x1000, true);
  v.setUint32(opt + 36, fileAlign, true);
  v.setUint16(opt + 68, subsystem, true);
  const nDirOff = opt + (pe32plus ? 108 : 92);
  v.setUint32(nDirOff, 16, true);
  const dirs = opt + (pe32plus ? 112 : 96);
  // Import directory in the single section.
  const descriptors = imports.length;
  const namesStart = (descriptors + 1) * 20;
  v.setUint32(dirs + 8, secRva, true);
  v.setUint32(dirs + 12, (descriptors + 1) * 20, true);
  if (dotnet) {
    v.setUint32(dirs + 14 * 8, secRva + 0x300, true);
    v.setUint32(dirs + 14 * 8 + 4, 72, true);
  }
  out.set(bytes(".idata\0\0"), secTable);
  v.setUint32(secTable + 8, 0x400, true);
  v.setUint32(secTable + 12, secRva, true);
  v.setUint32(secTable + 16, 0x400, true);
  v.setUint32(secTable + 20, secRaw, true);
  let nameAt = namesStart;
  imports.forEach((name, i) => {
    const d = secRaw + i * 20;
    v.setUint32(d + 12, secRva + nameAt, true);
    v.setUint32(d + 16, secRva + 0x380, true);
    out.set(bytes(name, [0]), secRaw + nameAt);
    nameAt += name.length + 1;
  });
  if (rsrc) {
    v.setUint32(dirs + 16, rsrcRva, true);
    v.setUint32(dirs + 20, rsrc.length, true);
    const sec = secTable + 40;
    out.set(bytes(".rsrc\0\0\0"), sec);
    v.setUint32(sec + 8, rsrc.length, true);
    v.setUint32(sec + 12, rsrcRva, true);
    v.setUint32(sec + 16, rsrcSize, true);
    v.setUint32(sec + 20, rsrcRaw, true);
    out.set(rsrc, rsrcRaw);
  }
  if (marker) out.set(bytes(marker), size);
  return out;
}

const utf16z = (str) => {
  const out = new Uint8Array(str.length * 2 + 2);
  for (let i = 0; i < str.length; i++) new DataView(out.buffer).setUint16(i * 2, str.charCodeAt(i), true);
  return out;
};
const le16 = (...vals) => {
  const out = new Uint8Array(vals.length * 2);
  vals.forEach((x, i) => {
    new DataView(out.buffer).setUint16(i * 2, x & 0xffff, true);
  });
  return out;
};
const le32 = (...vals) => {
  const out = new Uint8Array(vals.length * 4);
  vals.forEach((x, i) => {
    new DataView(out.buffer).setUint32(i * 4, x >>> 0, true);
  });
  return out;
};
const align4 = (parts) => {
  const data = bytes(...parts);
  const out = new Uint8Array(Math.ceil(data.length / 4) * 4);
  out.set(data);
  return out;
};

/** A .rsrc section (type → id → language 1033) for `entries` = [{ type, id, data }], placed at `rva`. */
function resourceSection(entries, rva) {
  const types = [...new Set(entries.map((e) => e.type))].sort((a, b) => a - b);
  const byType = types.map((t) => entries.filter((e) => e.type === t).sort((a, b) => a.id - b.id));
  const dirSize = (n) => 16 + n * 8;
  let at = dirSize(types.length);
  const typeDirAt = byType.map((list) => {
    const o = at;
    at += dirSize(list.length);
    return o;
  });
  const langDirAt = entries.map(() => {
    const o = at;
    at += dirSize(1);
    return o;
  });
  const dataEntryAt = entries.map(() => {
    const o = at;
    at += 16;
    return o;
  });
  const dataAt = entries.map((e) => {
    const o = at;
    at += Math.ceil(e.data.length / 4) * 4;
    return o;
  });
  const out = new Uint8Array(at);
  const v = new DataView(out.buffer);
  const dir = (o, n) => v.setUint16(o + 14, n, true);
  dir(0, types.length);
  types.forEach((t, ti) => {
    v.setUint32(16 + ti * 8, t, true);
    v.setUint32(20 + ti * 8, 0x80000000 | typeDirAt[ti], true);
    dir(typeDirAt[ti], byType[ti].length);
    byType[ti].forEach((e, ei) => {
      const k = entries.indexOf(e);
      v.setUint32(typeDirAt[ti] + 16 + ei * 8, e.id, true);
      v.setUint32(typeDirAt[ti] + 20 + ei * 8, 0x80000000 | langDirAt[k], true);
      dir(langDirAt[k], 1);
      v.setUint32(langDirAt[k] + 16, 1033, true);
      v.setUint32(langDirAt[k] + 20, dataEntryAt[k], true);
      v.setUint32(dataEntryAt[k], rva + dataAt[k], true);
      v.setUint32(dataEntryAt[k] + 4, e.data.length, true);
      out.set(e.data, dataAt[k]);
    });
  });
  return out;
}

/** RT_STRING block `block` (strings (block-1)*16 … +15); `strings` maps index 0–15 to text. */
export function rcStringTable(strings) {
  const parts = [];
  for (let i = 0; i < 16; i++) {
    const str = strings[i] ?? "";
    parts.push(le16(str.length), utf16z(str).subarray(0, str.length * 2));
  }
  return bytes(...parts);
}

/** RT_MENU (standard template): items are { text, id } or { text, items: [...] } popups. */
export function rcMenu(items) {
  const encode = (list) =>
    list.flatMap((item, i) => {
      const last = i === list.length - 1 ? 0x80 : 0;
      if (item.items) return [le16(0x10 | last), utf16z(item.text), ...encode(item.items)];
      return [le16(last), le16(item.id), utf16z(item.text)];
    });
  return bytes(le16(0, 0), ...encode(items));
}

/** RT_DIALOG (DLGTEMPLATE with DS_SETFONT): controls are { cls: 0x80–0x85, text, id, x, y, cx, cy }. */
export function rcDialog({ caption, x = 0, y = 0, cx = 200, cy = 100, controls = [] }) {
  const parts = [
    align4([
      le32(0x80c800c0, 0),
      le16(controls.length, x, y, cx, cy),
      le16(0, 0),
      utf16z(caption),
      le16(8),
      utf16z("MS Sans Serif"),
    ]),
  ];
  for (const c of controls) {
    parts.push(
      align4([
        le32(0x50010000, 0),
        le16(c.x, c.y, c.cx, c.cy, c.id),
        le16(0xffff, c.cls),
        utf16z(c.text),
        le16(0),
      ]),
    );
  }
  return bytes(...parts);
}

/** RT_VERSION with a StringFileInfo block holding `strings`. */
export function rcVersion(strings) {
  const node = (key, value, children = [], type = 1) => {
    const valueBytes = typeof value === "string" ? utf16z(value) : value;
    const head = align4([le16(0, valueBytes.length / (type === 1 ? 2 : 1), type), utf16z(key)]);
    const body = align4([valueBytes]);
    const kids = bytes(...children);
    const out = bytes(head, body, kids);
    new DataView(out.buffer).setUint16(0, out.length, true);
    return out;
  };
  const table = node(
    "040904b0",
    new Uint8Array(0),
    Object.entries(strings).map(([k, val]) => node(k, val)),
  );
  const sfi = node("StringFileInfo", new Uint8Array(0), [table]);
  const fixed = le32(0xfeef04bd, 0x10000, 0x10000, 0, 0x10000, 0, 0x3f, 0, 4, 1, 0, 0, 0);
  return node("VS_VERSION_INFO", fixed, [sfi], 0);
}

export function neExe({ os = 2 } = {}) {
  const out = new Uint8Array(0x200);
  out.set(bytes("MZ"), 0);
  new DataView(out.buffer).setUint32(0x3c, 0x80, true);
  out.set(bytes("NE"), 0x80);
  out[0x80 + 0x36] = os;
  return out;
}

export function leExe() {
  const out = new Uint8Array(0x400);
  out.set(bytes("MZ"), 0);
  new DataView(out.buffer).setUint32(0x3c, 0x80, true);
  out.set(bytes("LE"), 0x80);
  out.set(bytes("DOS/4G"), 0x300);
  return out;
}

export function machO({ fat = false } = {}) {
  if (fat) {
    const out = new Uint8Array(64);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0xcafebabe, false);
    v.setUint32(4, 2, false);
    v.setUint32(8, 0x01000007, false);
    v.setUint32(28, 0x0100000c, false);
    return out;
  }
  const out = new Uint8Array(32);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0xfeedfacf, true);
  v.setUint32(4, 0x0100000c, true);
  return out;
}

// ---------------------------------------------------------------------------
// Java class file header + jars.
export function classFile(major = 52, extra = "") {
  const out = bytes([0xca, 0xfe, 0xba, 0xbe, 0, 0, (major >> 8) & 0xff, major & 0xff], extra);
  return out;
}

export function jar({ mainClass = "hello.Main", major = 52, swing = true } = {}) {
  const path = `${mainClass.replace(/\./g, "/")}.class`;
  return zipSync({
    "META-INF/MANIFEST.MF": enc.encode(
      `Manifest-Version: 1.0\r\nMain-Class: ${mainClass}\r\nCreated-By: test\r\n\r\n`,
    ),
    [path]: classFile(major, swing ? "javax/swing/JFrame" : "java/lang/System"),
  });
}

const ANDROID_NS = "http://schemas.android.com/apk/res/android";
const ANDROID_ATTRS = {
  name: 0x01010003,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
};

/**
 * Compile an element tree ({ name, attrs: { key: value }, children }) to Android binary XML, as aapt
 * does. Attributes named in ANDROID_ATTRS get the android: namespace; `stripNames` blanks their
 * names in the string pool the way obfuscators do, leaving only the resource map.
 */
export function axml(root, { stripNames = false } = {}) {
  const strings = Object.keys(ANDROID_ATTRS);
  const idx = (str) => {
    let i = strings.indexOf(str);
    if (i < 0) i = strings.push(str) - 1;
    return i;
  };
  const nsPrefix = idx("android");
  const nsUri = idx(ANDROID_NS);
  const chunk = (type, headerSize, body) => {
    const out = new Uint8Array(8 + body.length);
    const v = new DataView(out.buffer);
    v.setUint16(0, type, true);
    v.setUint16(2, headerSize, true);
    v.setUint32(4, out.length, true);
    out.set(body, 8);
    return out;
  };
  const words = (...vals) => {
    const out = new Uint8Array(vals.length * 4);
    const v = new DataView(out.buffer);
    vals.forEach((x, i) => {
      v.setUint32(i * 4, x >>> 0, true);
    });
    return out;
  };
  const NONE = 0xffffffff;
  const nodes = [];
  const walk = (el) => {
    const attrs = Object.entries(el.attrs ?? {});
    const body = new Uint8Array(8 + 20 + attrs.length * 20);
    const v = new DataView(body.buffer);
    v.setUint32(0, 1, true); // line
    v.setUint32(4, NONE, true); // comment
    v.setUint32(8, NONE, true); // element namespace
    v.setUint32(12, idx(el.name), true);
    v.setUint16(16, 20, true); // attributeStart
    v.setUint16(18, 20, true); // attributeSize
    v.setUint16(20, attrs.length, true);
    attrs.forEach(([key, value], i) => {
      const a = 28 + i * 20;
      v.setUint32(a, key in ANDROID_ATTRS ? nsUri : NONE, true);
      v.setUint32(a + 4, idx(key), true);
      v.setUint16(a + 12, 8, true);
      if (typeof value === "string") {
        v.setUint32(a + 8, idx(value), true);
        v.setUint8(a + 15, 0x03);
        v.setUint32(a + 16, idx(value), true);
      } else {
        v.setUint32(a + 8, NONE, true);
        v.setUint8(a + 15, typeof value === "boolean" ? 0x12 : 0x10);
        v.setUint32(a + 16, typeof value === "boolean" ? (value ? NONE : 0) : value, true);
      }
    });
    nodes.push(chunk(0x0102, 16, body));
    for (const c of el.children ?? []) walk(c);
    nodes.push(chunk(0x0103, 16, words(1, NONE, NONE, idx(el.name))));
  };
  walk(root);
  const startNs = chunk(0x0100, 16, words(1, NONE, nsPrefix, nsUri));
  const endNs = chunk(0x0101, 16, words(1, NONE, nsPrefix, nsUri));

  const pool = strings.map((str, i) => (stripNames && i < Object.keys(ANDROID_ATTRS).length ? "" : str));
  const encoded = pool.map((str) => {
    const out = new Uint8Array(2 + str.length * 2 + 2);
    const v = new DataView(out.buffer);
    v.setUint16(0, str.length, true);
    for (let i = 0; i < str.length; i++) v.setUint16(2 + i * 2, str.charCodeAt(i), true);
    return out;
  });
  let offset = 0;
  const offsets = encoded.map((e) => {
    const o = offset;
    offset += e.length;
    return o;
  });
  const data = bytes(...encoded);
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  const poolHeader = words(pool.length, 0, 0, 28 + pool.length * 4, 0);
  const stringPool = chunk(0x0001, 28, bytes(poolHeader, words(...offsets), padded));
  const resourceMap = chunk(0x0180, 8, words(...Object.values(ANDROID_ATTRS)));
  return chunk(0x0003, 8, bytes(stringPool, resourceMap, startNs, ...nodes, endNs));
}

/** A manifest for package `pkg` with one launcher activity. */
export function androidManifest({
  pkg = "com.example.hello",
  activity = ".MainActivity",
  stripNames = false,
} = {}) {
  const action = { name: "action", attrs: { name: "android.intent.action.MAIN" } };
  const category = { name: "category", attrs: { name: "android.intent.category.LAUNCHER" } };
  return axml(
    {
      name: "manifest",
      attrs: { versionCode: 7, versionName: "1.2.3", package: pkg },
      children: [
        { name: "uses-sdk", attrs: { minSdkVersion: 21, targetSdkVersion: 34 } },
        {
          name: "application",
          attrs: { label: "Hello" },
          children: [
            { name: "activity", attrs: { name: ".SettingsActivity" } },
            {
              name: "activity",
              attrs: { name: activity },
              children: [{ name: "intent-filter", children: [action, category] }],
            },
          ],
        },
      ],
    },
    { stripNames },
  );
}

export function apk({ pkg, abis = [], stripNames = false } = {}) {
  const files = {
    "AndroidManifest.xml": androidManifest({ pkg, stripNames }),
    "classes.dex": bytes("dex\n035\0"),
    "resources.arsc": new Uint8Array(4),
  };
  for (const abi of abis) files[`lib/${abi}/libnative.so`] = elfDynamic({ bits: 64 });
  return zipSync(files);
}

// ---------------------------------------------------------------------------
// ISO 9660 header with an El Torito boot record.
export function isoImage({ bootable = true, label = "TESTDISC" } = {}) {
  const out = new Uint8Array(20 * 2048);
  out[0x8000] = 1;
  out.set(bytes("CD001", [1]), 0x8001);
  out.set(bytes(label.padEnd(32, " ")), 0x8028);
  if (bootable) {
    out[0x8800] = 0;
    out.set(bytes("CD001", [1], "EL TORITO SPECIFICATION"), 0x8801);
  }
  out[0x9000] = 255;
  out.set(bytes("CD001"), 0x9001);
  return out;
}

// ---------------------------------------------------------------------------
// SWF writer for an animated sample movie.
class BitWriter {
  bytes = [];
  cur = 0;
  n = 0;
  ub(bits, value) {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1);
      this.n++;
      if (this.n === 8) this.flush();
    }
  }
  sb(bits, value) {
    this.ub(bits, value & ((1 << bits) - 1));
  }
  flush() {
    if (this.n === 0) return;
    this.bytes.push((this.cur << (8 - this.n)) & 0xff);
    this.cur = 0;
    this.n = 0;
  }
  align() {
    this.flush();
  }
  out() {
    this.flush();
    return this.bytes;
  }
}

function sbits(...values) {
  let n = 1;
  for (const v of values) {
    while (v < -(1 << (n - 1)) || v > (1 << (n - 1)) - 1) n++;
  }
  return n;
}

function rect(w, xmin, xmax, ymin, ymax) {
  const n = sbits(xmin, xmax, ymin, ymax);
  w.ub(5, n);
  for (const v of [xmin, xmax, ymin, ymax]) w.sb(n, v);
  w.align();
}

function matrix(w, { scale, rotate, tx = 0, ty = 0 } = {}) {
  if (scale) {
    w.ub(1, 1);
    const n = sbits(scale[0], scale[1]);
    w.ub(5, n);
    w.sb(n, scale[0]);
    w.sb(n, scale[1]);
  } else w.ub(1, 0);
  if (rotate) {
    w.ub(1, 1);
    const n = sbits(rotate[0], rotate[1]);
    w.ub(5, n);
    w.sb(n, rotate[0]);
    w.sb(n, rotate[1]);
  } else w.ub(1, 0);
  const n = sbits(tx, ty);
  w.ub(5, n);
  w.sb(n, tx);
  w.sb(n, ty);
  w.align();
}

function tag(code, body) {
  const b = [...body];
  if (b.length < 63) return [...u16((code << 6) | b.length), ...b];
  return [...u16((code << 6) | 0x3f), ...u32(b.length), ...b];
}

function squareShape(id, rgb, half) {
  const w = new BitWriter();
  w.bytes.push(...u16(id));
  rect(w, -half, half, -half, half);
  w.bytes.push(1, 0x00, ...rgb); // one solid fill
  w.bytes.push(0); // no line styles
  w.ub(4, 1); // fill bits
  w.ub(4, 0); // line bits
  // StyleChangeRecord: moveTo + fillStyle1
  w.ub(1, 0);
  w.ub(5, 0b00101);
  const mb = sbits(-half, -half);
  w.ub(5, mb);
  w.sb(mb, -half);
  w.sb(mb, -half);
  w.ub(1, 1);
  for (const [dx, dy] of [
    [2 * half, 0],
    [0, 2 * half],
    [-2 * half, 0],
    [0, -2 * half],
  ]) {
    const nb = Math.max(2, sbits(dx, dy));
    w.ub(1, 1); // edge
    w.ub(1, 1); // straight
    w.ub(4, nb - 2);
    w.ub(1, 1); // general line
    w.sb(nb, dx);
    w.sb(nb, dy);
  }
  w.ub(6, 0); // end of shape
  return tag(2, w.out());
}

function place(depth, id, m, move = false) {
  const w = new BitWriter();
  w.bytes.push(move ? 0x05 : 0x06, ...u16(depth));
  if (!move) w.bytes.push(...u16(id));
  matrix(w, m);
  return tag(26, w.out());
}

export function swfMovie({ frames = 72 } = {}) {
  const width = 550 * 20;
  const height = 400 * 20;
  const body = new BitWriter();
  rect(body, 0, width, 0, height);
  body.bytes.push(0, 24, ...u16(frames));
  const tags = [];
  tags.push(...tag(69, u32(0)));
  tags.push(...tag(9, [0x15, 0x19, 0x24]));
  tags.push(...squareShape(1, [0x7a, 0xa2, 0xff], 1200));
  tags.push(...squareShape(2, [0xff, 0x9f, 0x43], 700));
  tags.push(...squareShape(3, [0x6c, 0xe0, 0x9a], 500));
  for (let f = 0; f < frames; f++) {
    const t = (f / frames) * Math.PI * 2;
    const cos = Math.round(Math.cos(t) * 65536);
    const sin = Math.round(Math.sin(t) * 65536);
    const rot = { scale: [cos, cos], rotate: [sin, -sin] };
    const first = f === 0;
    tags.push(...place(1, 1, { ...rot, tx: Math.round(width / 2), ty: Math.round(height / 2) }, !first));
    tags.push(
      ...place(
        2,
        2,
        {
          tx: Math.round(width / 2 + Math.cos(-t * 2) * 3600),
          ty: Math.round(height / 2 + Math.sin(-t * 2) * 2600),
        },
        !first,
      ),
    );
    tags.push(
      ...place(
        3,
        3,
        {
          scale: [cos, cos],
          rotate: [-sin, sin],
          tx: Math.round(width / 2 + Math.cos(t + Math.PI) * 2200),
          ty: Math.round(height / 2 + Math.sin(t + Math.PI) * 1600),
        },
        !first,
      ),
    );
    tags.push(...tag(1, []));
  }
  tags.push(...tag(0, []));
  const content = [...body.out(), ...tags];
  return bytes("FWS", [10], u32(8 + content.length), content);
}

// ---------------------------------------------------------------------------
// asar archive.
export function asar(files) {
  const tree = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const data = typeof text === "string" ? enc.encode(text) : text;
    const parts = path.split("/");
    let node = tree;
    for (const dir of parts.slice(0, -1)) {
      node.files[dir] ??= { files: {} };
      node = node.files[dir];
    }
    node.files[parts.at(-1)] = { size: data.length, offset: String(offset) };
    blobs.push(data);
    offset += data.length;
  }
  const json = enc.encode(JSON.stringify(tree));
  const jsonPadded = (json.length + 3) & ~3;
  const headerPickle = 8 + jsonPadded;
  const head = new Uint8Array(16 + jsonPadded);
  const v = new DataView(head.buffer);
  v.setUint32(0, 4, true);
  v.setUint32(4, headerPickle, true);
  v.setUint32(8, headerPickle - 4, true);
  v.setUint32(12, json.length, true);
  head.set(json, 16);
  return bytes(head, ...blobs);
}

export const webIndex = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hello web</title></head>
<body style="font-family:system-ui;background:#0b0d12;color:#e8ebf2;display:grid;place-items:center;height:100vh;margin:0">
<main><h1>Hello from a static site</h1><p>Published unchanged by webapp-anything.</p></main>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Tiny two-pass assembler: byte arrays plus {label} marks and {abs|rel8: label} references.
function assemble(origin, parts) {
  const labels = {};
  const size = (p) => (typeof p === "number" ? 1 : p.label !== undefined ? 0 : p.abs !== undefined ? 2 : 1);
  let at = origin;
  for (const p of parts) {
    if (p.label !== undefined) labels[p.label] = at;
    at += size(p);
  }
  const out = [];
  at = origin;
  for (const p of parts) {
    if (typeof p === "number") out.push(p);
    else if (p.abs !== undefined) out.push(...u16(labels[p.abs]));
    else if (p.rel8 !== undefined) {
      const rel = labels[p.rel8] - (at + 1);
      if (rel < -128 || rel > 127) throw new Error(`jump to ${p.rel8} out of range`);
      out.push(rel & 0xff);
    }
    at += size(p);
  }
  return Uint8Array.from(out);
}

const text = (s) => [...enc.encode(s)];

/**
 * DOS .COM that keeps a run counter in COUNTER.DAT: it reads the byte, increments it, writes it
 * back and prints "This DOS program has run NNN times." Used to test saved games.
 */
export function counterCom() {
  const L = (label) => ({ label });
  const A = (abs) => ({ abs });
  const R = (rel8) => ({ rel8 });
  return assemble(0x100, [
    0xb8,
    0x02,
    0x3d, // mov ax, 3D02h  (open read/write)
    0xba,
    A("fname"), // mov dx, fname
    0xcd,
    0x21,
    0x73,
    R("opened"), // jnc opened
    0xb4,
    0x3c, // mov ah, 3Ch     (create)
    0x31,
    0xc9, // xor cx, cx
    0xba,
    A("fname"),
    0xcd,
    0x21,
    0x72,
    R("fail"), // jc fail
    0xeb,
    R("have"),
    L("opened"),
    0x89,
    0xc3, // mov bx, ax
    0xb4,
    0x3f, // mov ah, 3Fh     (read 1 byte)
    0xb9,
    0x01,
    0x00,
    0xba,
    A("count"),
    0xcd,
    0x21,
    0x89,
    0xd8, // mov ax, bx
    L("have"),
    0x89,
    0xc3, // mov bx, ax      (handle)
    0xfe,
    0x06,
    A("count"), // inc byte [count]
    0xb8,
    0x00,
    0x42, // mov ax, 4200h  (seek to start)
    0x31,
    0xc9,
    0x31,
    0xd2,
    0xcd,
    0x21,
    0xb4,
    0x40, // mov ah, 40h     (write 1 byte)
    0xb9,
    0x01,
    0x00,
    0xba,
    A("count"),
    0xcd,
    0x21,
    0xb4,
    0x3e, // mov ah, 3Eh     (close)
    0xcd,
    0x21,
    0xa0,
    A("count"), // mov al, [count]
    0xb4,
    0x00, // mov ah, 0
    0xb3,
    0x64, // mov bl, 100
    0xf6,
    0xf3, // div bl
    0x04,
    0x30, // add al, '0'
    0xa2,
    A("d0"), // mov [d0], al
    0x8a,
    0xc4, // mov al, ah
    0xd4,
    0x0a, // aam
    0x05,
    0x30,
    0x30, // add ax, 3030h
    0x88,
    0x26,
    A("d1"), // mov [d1], ah
    0xa2,
    A("d2"), // mov [d2], al
    0xb4,
    0x09,
    0xba,
    A("msg"),
    0xcd,
    0x21,
    L("done"),
    0xb4,
    0x00, // wait for a key
    0xcd,
    0x16,
    0xb8,
    0x00,
    0x4c,
    0xcd,
    0x21,
    L("fail"),
    0xb4,
    0x09,
    0xba,
    A("err"),
    0xcd,
    0x21,
    0xeb,
    R("done"),
    L("fname"),
    ...text("COUNTER.DAT"),
    0,
    L("count"),
    0,
    L("msg"),
    ...text("This DOS program has run "),
    L("d0"),
    0x30,
    L("d1"),
    0x30,
    L("d2"),
    0x30,
    ...text(" times.\r\nIts counter is saved in COUNTER.DAT.\r\n$"),
    L("err"),
    ...text("Could not open COUNTER.DAT.$"),
  ]);
}
