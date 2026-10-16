/**
 * Windows PE resources: the menus, dialogs, string tables and version info that describe a
 * program's user interface. Used by `waa rebuild` so the agent can see the UI without running it.
 */

export const RT = {
  ICON: 3,
  MENU: 4,
  DIALOG: 5,
  STRING: 6,
  ACCELERATOR: 9,
  GROUP_ICON: 14,
  VERSION: 16,
} as const;

const TYPE_NAMES: Record<number, string> = {
  1: "cursor",
  2: "bitmap",
  3: "icon",
  4: "menu",
  5: "dialog",
  6: "string",
  9: "accelerator",
  10: "rcdata",
  12: "group_cursor",
  14: "group_icon",
  16: "version",
  24: "manifest",
};

const CONTROL_CLASSES: Record<number, string> = {
  128: "Button",
  129: "Edit",
  130: "Static",
  131: "ListBox",
  132: "ScrollBar",
  133: "ComboBox",
};

export interface ResourceEntry {
  type: number | string;
  name: number | string;
  lang: number;
  data: Uint8Array;
}

export interface MenuItem {
  text: string;
  id?: number;
  items?: MenuItem[];
}

export interface DialogControl {
  class: string;
  text: string;
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  style: number;
}

export interface Dialog {
  id: number | string;
  caption: string;
  x: number;
  y: number;
  width: number;
  height: number;
  font?: string;
  controls: DialogControl[];
}

export interface PeResources {
  /** How many resources of each type the file has (e.g. { icon: 4, dialog: 2 }). */
  counts: Record<string, number>;
  strings: { id: number; text: string }[];
  menus: { id: number | string; items: MenuItem[] }[];
  dialogs: Dialog[];
  version?: Record<string, string>;
  manifest?: string;
}

/** Locate and walk the resource directory of a PE file. Returns [] for files without one. */
export function readResourceEntries(bytes: Uint8Array): ResourceEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => (o + 2 <= bytes.length ? v.getUint16(o, true) : 0);
  const u32 = (o: number) => (o + 4 <= bytes.length ? v.getUint32(o, true) : 0);
  if (u16(0) !== 0x5a4d) return [];
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) return [];
  const coff = pe + 4;
  const numSections = u16(coff + 2);
  const optSize = u16(coff + 16);
  const opt = coff + 20;
  const plus = u16(opt) === 0x20b;
  const numDirs = u32(opt + (plus ? 108 : 92));
  if (numDirs < 3) return [];
  const dirs = opt + (plus ? 112 : 96);
  const rsrcRva = u32(dirs + 16);
  if (!rsrcRva) return [];
  const sections: { va: number; size: number; raw: number }[] = [];
  for (let i = 0; i < Math.min(numSections, 96); i++) {
    const s = opt + optSize + i * 40;
    sections.push({ size: Math.max(u32(s + 8), u32(s + 16)), va: u32(s + 12), raw: u32(s + 20) });
  }
  const toOffset = (rva: number) => {
    for (const s of sections) if (rva >= s.va && rva < s.va + s.size) return rva - s.va + s.raw;
    return -1;
  };
  const base = toOffset(rsrcRva);
  if (base < 0) return [];

  const name = (field: number): number | string => {
    if (!(field & 0x80000000)) return field;
    const at = base + (field & 0x7fffffff);
    const len = u16(at);
    let str = "";
    for (let i = 0; i < len; i++) str += String.fromCharCode(u16(at + 2 + i * 2));
    return str;
  };
  const out: ResourceEntry[] = [];
  const seen = new Set<number>();
  const walk = (dirAt: number, path: (number | string)[]) => {
    if (seen.has(dirAt) || path.length > 2 || dirAt + 16 > bytes.length) return;
    seen.add(dirAt);
    const count = Math.min(u16(dirAt + 12) + u16(dirAt + 14), 4096);
    for (let i = 0; i < count; i++) {
      const e = dirAt + 16 + i * 8;
      const id = name(u32(e));
      const target = u32(e + 4);
      if (target & 0x80000000) walk(base + (target & 0x7fffffff), [...path, id]);
      else if (path.length === 2) {
        const entry = base + target;
        const off = toOffset(u32(entry));
        const size = u32(entry + 4);
        if (off < 0 || off + size > bytes.length) continue;
        const [type, resName] = path as [number | string, number | string];
        out.push({
          type,
          name: resName,
          lang: typeof id === "number" ? id : 0,
          data: bytes.subarray(off, off + size),
        });
      }
    }
  };
  walk(base, []);
  return out;
}

class Cursor {
  private readonly v: DataView;
  constructor(
    readonly data: Uint8Array,
    public at = 0,
  ) {
    this.v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  get done() {
    return this.at >= this.data.length;
  }
  u16() {
    const x = this.at + 2 <= this.data.length ? this.v.getUint16(this.at, true) : 0;
    this.at += 2;
    return x;
  }
  i16() {
    const x = this.at + 2 <= this.data.length ? this.v.getInt16(this.at, true) : 0;
    this.at += 2;
    return x;
  }
  u32() {
    const x = this.at + 4 <= this.data.length ? this.v.getUint32(this.at, true) : 0;
    this.at += 4;
    return x;
  }
  u8() {
    return this.data[this.at++] ?? 0;
  }
  /** NUL-terminated UTF-16 string. */
  sz() {
    let s = "";
    while (this.at + 2 <= this.data.length) {
      const c = this.u16();
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  /** A string or a 0xFFFF-prefixed ordinal (dialog menus, classes and titles). */
  szOrOrd(): string | number {
    if (this.at + 2 <= this.data.length && this.v.getUint16(this.at, true) === 0xffff) {
      this.at += 2;
      return this.u16();
    }
    return this.sz();
  }
  align4() {
    this.at = (this.at + 3) & ~3;
  }
}

export function parseStringTable(block: number, data: Uint8Array): { id: number; text: string }[] {
  const c = new Cursor(data);
  const out: { id: number; text: string }[] = [];
  for (let i = 0; i < 16 && !c.done; i++) {
    const len = c.u16();
    let text = "";
    for (let k = 0; k < len; k++) text += String.fromCharCode(c.u16());
    if (text) out.push({ id: (block - 1) * 16 + i, text });
  }
  return out;
}

export function parseMenu(data: Uint8Array): MenuItem[] {
  const c = new Cursor(data);
  const version = c.u16();
  const offset = c.u16();
  if (version === 1) {
    // MENUEX: items start after the header's offset field.
    c.at = 4 + offset;
    const readEx = (depth: number): MenuItem[] => {
      const items: MenuItem[] = [];
      while (!c.done && depth < 8) {
        c.u32(); // type
        c.u32(); // state
        const id = c.u32();
        const flags = c.u16();
        const text = c.sz();
        c.align4();
        const item: MenuItem = { text };
        if (flags & 0x01) {
          c.u32(); // help id
          item.items = readEx(depth + 1);
        } else item.id = id;
        items.push(item);
        if (flags & 0x80) break;
      }
      return items;
    };
    return readEx(0);
  }
  c.at = 4 + offset;
  const read = (depth: number): MenuItem[] => {
    const items: MenuItem[] = [];
    while (!c.done && depth < 8) {
      const flags = c.u16();
      const item: MenuItem = { text: "" };
      if (flags & 0x10) {
        item.text = c.sz();
        item.items = read(depth + 1);
      } else {
        item.id = c.u16();
        item.text = c.sz();
      }
      items.push(item);
      if (flags & 0x80) break;
    }
    return items;
  };
  return read(0);
}

export function parseDialog(id: number | string, data: Uint8Array): Dialog {
  const c = new Cursor(data);
  const ex = c.u16() === 1 && c.u16() === 0xffff;
  let style: number;
  let count: number;
  if (ex) {
    c.u32(); // help id
    c.u32(); // ex style
    style = c.u32();
  } else {
    c.at = 0;
    style = c.u32();
    c.u32(); // ex style
  }
  count = c.u16();
  const x = c.i16();
  const y = c.i16();
  const width = c.i16();
  const height = c.i16();
  c.szOrOrd(); // menu
  c.szOrOrd(); // window class
  const caption = c.sz();
  let font: string | undefined;
  if (style & 0x48) {
    const size = c.u16();
    if (ex) {
      c.u16(); // weight
      c.u8(); // italic
      c.u8(); // charset
    }
    font = `${c.sz()} ${size}pt`;
  }
  const controls: DialogControl[] = [];
  count = Math.min(count, 1024);
  for (let i = 0; i < count && !c.done; i++) {
    c.align4();
    let ctlStyle: number;
    let ctlId: number;
    if (ex) {
      c.u32(); // help id
      c.u32(); // ex style
      ctlStyle = c.u32();
    } else {
      ctlStyle = c.u32();
      c.u32(); // ex style
    }
    const cx = c.i16();
    const cy = c.i16();
    const cw = c.i16();
    const ch = c.i16();
    ctlId = ex ? c.u32() : c.u16();
    const cls = c.szOrOrd();
    const text = c.szOrOrd();
    const extra = c.u16();
    c.at += extra;
    if (ctlId === 0xffff) ctlId = -1;
    controls.push({
      class: typeof cls === "number" ? (CONTROL_CLASSES[cls] ?? `#${cls}`) : cls,
      text: typeof text === "number" ? `#${text}` : text,
      id: ctlId,
      x: cx,
      y: cy,
      width: cw,
      height: ch,
      style: ctlStyle,
    });
  }
  return { id, caption, x, y, width, height, font, controls };
}

/** The StringFileInfo key/value pairs (CompanyName, FileDescription, ProductVersion…). */
export function parseVersionInfo(data: Uint8Array): Record<string, string> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Record<string, string> = {};
  const node = (at: number, end: number, depth: number) => {
    if (depth > 6 || at + 6 > end) return;
    const length = v.getUint16(at, true);
    const valueLength = v.getUint16(at + 2, true);
    const type = v.getUint16(at + 4, true);
    const nodeEnd = Math.min(end, at + length);
    if (length < 6) return;
    const c = new Cursor(data, at + 6);
    const key = c.sz();
    c.align4();
    const valueAt = c.at;
    if (type === 1 && valueLength && depth >= 3) {
      let value = "";
      for (let i = 0; i < valueLength; i++) {
        const ch = v.getUint16(valueAt + i * 2, true);
        if (!ch) break;
        value += String.fromCharCode(ch);
      }
      out[key] = value;
    }
    let child = (valueAt + (type === 1 ? valueLength * 2 : valueLength) + 3) & ~3;
    while (child + 6 <= nodeEnd) {
      const childLen = v.getUint16(child, true);
      if (!childLen) break;
      node(child, nodeEnd, depth + 1);
      child = (child + childLen + 3) & ~3;
    }
  };
  node(0, data.length, 0);
  // Depth: VS_VERSION_INFO (0) → StringFileInfo (1) → table (2) → strings (3).
  return out;
}

export function readPeResources(bytes: Uint8Array): PeResources {
  const entries = readResourceEntries(bytes);
  const res: PeResources = { counts: {}, strings: [], menus: [], dialogs: [] };
  for (const e of entries) {
    const typeName = typeof e.type === "number" ? (TYPE_NAMES[e.type] ?? `type${e.type}`) : e.type;
    res.counts[typeName] = (res.counts[typeName] ?? 0) + 1;
    try {
      if (e.type === RT.STRING && typeof e.name === "number")
        res.strings.push(...parseStringTable(e.name, e.data));
      else if (e.type === RT.MENU) res.menus.push({ id: e.name, items: parseMenu(e.data) });
      else if (e.type === RT.DIALOG) res.dialogs.push(parseDialog(e.name, e.data));
      else if (e.type === RT.VERSION && !res.version) res.version = parseVersionInfo(e.data);
      else if (e.type === 24 && !res.manifest) res.manifest = new TextDecoder().decode(e.data).slice(0, 4000);
    } catch {
      // A malformed resource should not hide the others.
    }
  }
  res.strings.sort((a, b) => a.id - b.id);
  return res;
}
