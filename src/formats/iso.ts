// Minimal ISO 9660 (level 1) + Joliet image writer: enough for an operating system inside an
// emulator to read a program's files from a CD-ROM drive, with long names via Joliet.

const SECTOR = 2048;

export interface IsoFile {
  /** POSIX path inside the image. */
  path: string;
  data: Uint8Array;
}

interface Dir {
  name: string;
  parent?: Dir;
  dirs: Map<string, Dir>;
  files: { name: string; data: Uint8Array; lba: number }[];
  /** LBA and byte size of this directory's extent, per hierarchy (primary / Joliet). */
  extent: [number, number];
  size: [number, number];
  number: number;
}

function both16(n: number): number[] {
  return [n & 255, (n >> 8) & 255, (n >> 8) & 255, n & 255];
}

function both32(n: number): number[] {
  const le = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  return [...le, ...[...le].reverse()];
}

function dirDate(d: Date): number[] {
  return [
    d.getUTCFullYear() - 1900,
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    0,
  ];
}

function volumeDate(d: Date): number[] {
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  const s = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1, 2)}${p(d.getUTCDate(), 2)}${p(d.getUTCHours(), 2)}${p(d.getUTCMinutes(), 2)}${p(d.getUTCSeconds(), 2)}00`;
  return [...s].map((c) => c.charCodeAt(0)).concat([0]);
}

function ascii(s: string, len: number): number[] {
  const out = new Array<number>(len).fill(0x20);
  for (let i = 0; i < Math.min(len, s.length); i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

function ucs2(s: string, maxChars = 64): number[] {
  const out: number[] = [];
  for (const ch of s.slice(0, maxChars)) {
    const c = ch.charCodeAt(0);
    out.push(c >> 8, c & 255);
  }
  return out;
}

const D_CHARS = /[^A-Z0-9_]/g;

/** Unique ISO 9660 level-1 names (8.3, upper case) for one directory. */
function shortNames(names: string[], isDir: (n: string) => boolean): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const name of [...names].sort()) {
    const dot = isDir(name) ? -1 : name.lastIndexOf(".");
    const stem = (dot > 0 ? name.slice(0, dot) : name).toUpperCase().replace(D_CHARS, "_") || "_";
    const ext =
      dot > 0
        ? name
            .slice(dot + 1)
            .toUpperCase()
            .replace(D_CHARS, "_")
            .slice(0, 3)
        : "";
    let candidate = stem.slice(0, 8);
    for (let n = 1; used.has(`${candidate}.${ext}`); n++) {
      const suffix = `~${n}`;
      candidate = stem.slice(0, 8 - suffix.length) + suffix;
    }
    used.add(`${candidate}.${ext}`);
    out.set(name, isDir(name) ? candidate : `${candidate}.${ext};1`);
  }
  return out;
}

function record(lba: number, size: number, flags: number, name: number[], date: Date): number[] {
  const len = 33 + name.length + (name.length % 2 === 0 ? 1 : 0);
  const r = [
    len,
    0,
    ...both32(lba),
    ...both32(size),
    ...dirDate(date),
    flags,
    0,
    0,
    ...both16(1),
    name.length,
    ...name,
  ];
  if (name.length % 2 === 0) r.push(0);
  return r;
}

/** Build an ISO image with the given files. `label` becomes the volume name (max 32 chars). */
export function buildIso(
  files: readonly IsoFile[],
  label = "WEBAPP_ANYTHING",
  date = new Date(),
): Uint8Array {
  const root: Dir = { name: "", dirs: new Map(), files: [], extent: [0, 0], size: [0, 0], number: 1 };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = {
          name: part,
          parent: dir,
          dirs: new Map(),
          files: [],
          extent: [0, 0],
          size: [0, 0],
          number: 0,
        };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push({ name: parts.at(-1)!, data: f.data, lba: 0 });
  }
  // Breadth-first order: required for path tables and gives directory numbers.
  const order: Dir[] = [root];
  for (let i = 0; i < order.length; i++) {
    for (const child of [...order[i]!.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)))
      order.push(child);
  }
  order.forEach((d, i) => {
    d.number = i + 1;
  });

  const namesFor = (d: Dir) =>
    shortNames([...d.dirs.keys(), ...d.files.map((f) => f.name)], (n) => d.dirs.has(n));
  const shortCache = new Map(order.map((d) => [d, namesFor(d)]));
  const nameBytes = (d: Dir, name: string, joliet: boolean) =>
    joliet ? ucs2(name) : [...shortCache.get(d)!.get(name)!].map((c) => c.charCodeAt(0));

  // Each directory's extent, laid out so no record crosses a sector boundary.
  const dirExtentSize = (d: Dir, joliet: boolean) => {
    let size = 34 * 2;
    let used = 34 * 2;
    const entries = [...d.dirs.keys(), ...d.files.map((f) => f.name)];
    for (const name of entries) {
      const n = nameBytes(d, name, joliet).length;
      const len = 33 + n + (n % 2 === 0 ? 1 : 0);
      if (used + len > SECTOR) {
        size += SECTOR - used;
        used = 0;
      }
      size += len;
      used += len;
    }
    return Math.ceil(size / SECTOR) * SECTOR;
  };

  const pathTable = (joliet: boolean, bigEndian: boolean, lbaOf: (d: Dir) => number) => {
    const out: number[] = [];
    for (const d of order) {
      const name = d === root ? [0] : nameBytes(d.parent!, d.name, joliet);
      const lba = lbaOf(d);
      const parent = d.parent ? d.parent.number : 1;
      out.push(name.length, 0);
      out.push(
        ...(bigEndian
          ? [(lba >>> 24) & 255, (lba >>> 16) & 255, (lba >>> 8) & 255, lba & 255]
          : [lba & 255, (lba >>> 8) & 255, (lba >>> 16) & 255, (lba >>> 24) & 255]),
      );
      out.push(...(bigEndian ? [(parent >> 8) & 255, parent & 255] : [parent & 255, (parent >> 8) & 255]));
      out.push(...name);
      if (name.length % 2) out.push(0);
    }
    return out;
  };

  // Path table sizes do not depend on LBAs, so measure them first.
  const ptSize = [pathTable(false, false, () => 0).length, pathTable(true, false, () => 0).length];
  const ptSectors = ptSize.map((s) => Math.ceil(s / SECTOR));
  let lba = 19; // 16 system area + PVD + SVD + terminator
  const ptLba = {
    pL: lba,
    pM: lba + ptSectors[0]!,
    jL: lba + 2 * ptSectors[0]!,
    jM: lba + 2 * ptSectors[0]! + ptSectors[1]!,
  };
  lba += 2 * ptSectors[0]! + 2 * ptSectors[1]!;
  for (const joliet of [false, true]) {
    const k = joliet ? 1 : 0;
    for (const d of order) {
      d.size[k] = dirExtentSize(d, joliet);
      d.extent[k] = lba;
      lba += d.size[k] / SECTOR;
    }
  }
  for (const d of order) {
    for (const f of d.files) {
      f.lba = lba;
      lba += Math.max(1, Math.ceil(f.data.length / SECTOR));
    }
  }
  const totalSectors = lba;
  const image = new Uint8Array(totalSectors * SECTOR);
  const put = (at: number, bytes: number[] | Uint8Array) => image.set(bytes, at);

  const writeDir = (d: Dir, joliet: boolean) => {
    const k = joliet ? 1 : 0;
    let pos = d.extent[k] * SECTOR;
    const end = pos + d.size[k];
    let used = 0;
    const emit = (r: number[]) => {
      if (used + r.length > SECTOR) {
        pos += SECTOR - used;
        used = 0;
      }
      put(pos, r);
      pos += r.length;
      used += r.length;
    };
    const parent = d.parent ?? d;
    emit(record(d.extent[k], d.size[k], 2, [0], date));
    emit(record(parent.extent[k], parent.size[k], 2, [1], date));
    const entries = [
      ...[...d.dirs.values()].map((c) => ({
        name: c.name,
        dir: c as Dir | undefined,
        file: undefined as (typeof d.files)[number] | undefined,
      })),
      ...d.files.map((f) => ({ name: f.name, dir: undefined, file: f })),
    ].sort((a, b) => {
      const an = joliet ? a.name : shortCache.get(d)!.get(a.name)!;
      const bn = joliet ? b.name : shortCache.get(d)!.get(b.name)!;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    for (const e of entries) {
      const name = nameBytes(d, e.name, joliet);
      if (e.dir) emit(record(e.dir.extent[k], e.dir.size[k], 2, name, date));
      else emit(record(e.file!.lba, e.file!.data.length, 0, name, date));
    }
    if (pos > end) throw new Error("ISO directory overflow");
  };

  const descriptor = (joliet: boolean) => {
    const k = joliet ? 1 : 0;
    const v = new Array<number>(SECTOR).fill(0);
    const set = (at: number, bytes: number[]) => {
      for (let i = 0; i < bytes.length; i++) v[at + i] = bytes[i]!;
    };
    set(0, [joliet ? 2 : 1, ...[..."CD001"].map((c) => c.charCodeAt(0)), 1]);
    set(8, joliet ? [...ucs2("WEBAPP-ANYTHING", 16)] : ascii("WEBAPP-ANYTHING", 32));
    const vol = label
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")
      .slice(0, 32);
    set(
      40,
      joliet
        ? [
            ...ucs2(label.slice(0, 16), 16),
            ...new Array(32 - Math.min(32, ucs2(label.slice(0, 16), 16).length)).fill(0),
          ]
        : ascii(vol, 32),
    );
    set(80, both32(totalSectors));
    if (joliet) set(88, [0x25, 0x2f, 0x45]); // %/E: UCS-2 level 3
    set(120, both16(1));
    set(124, both16(1));
    set(128, both16(SECTOR));
    set(132, both32(ptSize[k]!));
    const lL = joliet ? ptLba.jL : ptLba.pL;
    const lM = joliet ? ptLba.jM : ptLba.pM;
    set(140, [lL & 255, (lL >>> 8) & 255, (lL >>> 16) & 255, (lL >>> 24) & 255]);
    set(148, [(lM >>> 24) & 255, (lM >>> 16) & 255, (lM >>> 8) & 255, lM & 255]);
    set(156, record(root.extent[k], root.size[k], 2, [0], date));
    set(190, joliet ? new Array(128).fill(0) : ascii("", 128));
    set(318, joliet ? new Array(128).fill(0) : ascii("", 128));
    set(446, joliet ? new Array(128).fill(0) : ascii("", 128));
    set(574, joliet ? [...ucs2("WEBAPP-ANYTHING", 64)] : ascii("WEBAPP-ANYTHING", 128));
    set(813, volumeDate(date));
    set(830, volumeDate(date));
    set(847, [..."0000000000000000"].map((c) => c.charCodeAt(0)).concat([0]));
    set(864, [..."0000000000000000"].map((c) => c.charCodeAt(0)).concat([0]));
    set(881, [1]);
    return v;
  };

  put(16 * SECTOR, descriptor(false));
  put(17 * SECTOR, descriptor(true));
  put(18 * SECTOR, [255, ...[..."CD001"].map((c) => c.charCodeAt(0)), 1]);
  put(
    ptLba.pL * SECTOR,
    pathTable(false, false, (d) => d.extent[0]),
  );
  put(
    ptLba.pM * SECTOR,
    pathTable(false, true, (d) => d.extent[0]),
  );
  put(
    ptLba.jL * SECTOR,
    pathTable(true, false, (d) => d.extent[1]),
  );
  put(
    ptLba.jM * SECTOR,
    pathTable(true, true, (d) => d.extent[1]),
  );
  for (const d of order) {
    writeDir(d, false);
    writeDir(d, true);
  }
  for (const d of order) for (const f of d.files) put(f.lba * SECTOR, f.data);
  return image;
}

/** Read back an ISO image's files (Joliet names when present). Used by tests and `waa scan`. */
export function readIso(image: Uint8Array): { path: string; data: Uint8Array }[] {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  let rootAt = -1;
  let joliet = false;
  for (let s = 16; s < 32 && (s + 1) * SECTOR <= image.length; s++) {
    const t = image[s * SECTOR]!;
    if (t === 255) break;
    const isJoliet = t === 2 && image[s * SECTOR + 88] === 0x25 && image[s * SECTOR + 89] === 0x2f;
    if (t === 1 && rootAt < 0) rootAt = s * SECTOR + 156;
    if (isJoliet) {
      rootAt = s * SECTOR + 156;
      joliet = true;
    }
  }
  if (rootAt < 0) throw new Error("No ISO 9660 volume descriptor");
  const out: { path: string; data: Uint8Array }[] = [];
  const walk = (lba: number, size: number, prefix: string, depth: number) => {
    if (depth > 16) return;
    let pos = lba * SECTOR;
    const end = pos + size;
    while (pos < end) {
      const len = image[pos]!;
      if (len === 0) {
        pos = (Math.floor(pos / SECTOR) + 1) * SECTOR;
        continue;
      }
      const extent = view.getUint32(pos + 2, true);
      const dataLen = view.getUint32(pos + 10, true);
      const flags = image[pos + 25]!;
      const nameLen = image[pos + 32]!;
      const raw = image.subarray(pos + 33, pos + 33 + nameLen);
      pos += len;
      if (nameLen === 1 && (raw[0] === 0 || raw[0] === 1)) continue;
      let name = "";
      if (joliet)
        for (let i = 0; i + 1 < raw.length; i += 2) name += String.fromCharCode((raw[i]! << 8) | raw[i + 1]!);
      else
        name = String.fromCharCode(...raw)
          .replace(/;1$/, "")
          .replace(/\.$/, "");
      const full = prefix ? `${prefix}/${name}` : name;
      if (flags & 2) walk(extent, dataLen, full, depth + 1);
      else out.push({ path: full, data: image.subarray(extent * SECTOR, extent * SECTOR + dataLen) });
    }
  };
  walk(view.getUint32(rootAt + 2, true), view.getUint32(rootAt + 10, true), "", 0);
  return out;
}
