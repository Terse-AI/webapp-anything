/**
 * Android binary XML (the compiled AndroidManifest.xml inside an APK): just enough to read the
 * package name, version, SDK levels and the launcher activity.
 */

const RES_XML = 0x0003;
const RES_STRING_POOL = 0x0001;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const UTF8_FLAG = 0x100;

/** Resource ids of the android: attributes we read, for manifests whose attribute names are stripped. */
const ATTR_IDS: Record<number, string> = {
  16842755: "name",
  16843291: "versionCode",
  16843292: "versionName",
  16843276: "minSdkVersion",
  16843376: "targetSdkVersion",
};

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_BOOLEAN = 0x12;

export interface AxmlElement {
  name: string;
  attrs: Record<string, string | number | boolean>;
  children: AxmlElement[];
}

export interface AndroidManifestInfo {
  package?: string;
  versionName?: string;
  versionCode?: number;
  minSdk?: number;
  targetSdk?: number;
  /** Fully qualified launcher activity (action MAIN + category LAUNCHER). */
  launcher?: string;
}

function readStringPool(view: DataView, at: number): string[] {
  const headerSize = view.getUint16(at + 2, true);
  const count = view.getUint32(at + 8, true);
  const flags = view.getUint32(at + 16, true);
  const stringsStart = view.getUint32(at + 20, true);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const out: string[] = [];
  const base = at + stringsStart;
  for (let i = 0; i < count; i++) {
    let p = base + view.getUint32(at + headerSize + i * 4, true);
    if (utf8) {
      // utf16 length, then utf8 byte length; each is 1 byte or 2 with the high bit set.
      p += view.getUint8(p) & 0x80 ? 2 : 1;
      let len = view.getUint8(p);
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | view.getUint8(p + 1);
        p += 2;
      } else p += 1;
      out.push(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + p, len)));
    } else {
      let len = view.getUint16(p, true);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | view.getUint16(p + 2, true);
        p += 4;
      } else p += 2;
      let s = "";
      for (let c = 0; c < len; c++) s += String.fromCharCode(view.getUint16(p + c * 2, true));
      out.push(s);
    }
  }
  return out;
}

/** Parse a compiled XML document into its element tree. Throws on anything that is not binary XML. */
export function parseAxml(bytes: Uint8Array): AxmlElement {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint16(0, true) !== RES_XML)
    throw new Error("Not an Android binary XML file");
  let strings: string[] = [];
  let resourceIds: number[] = [];
  const root: AxmlElement = { name: "#document", attrs: {}, children: [] };
  const stack: AxmlElement[] = [root];
  let at = view.getUint16(2, true);
  const end = Math.min(bytes.length, view.getUint32(4, true));
  while (at + 8 <= end) {
    const type = view.getUint16(at, true);
    const headerSize = view.getUint16(at + 2, true);
    const size = view.getUint32(at + 4, true);
    if (size < 8 || at + size > end) throw new Error("Corrupt binary XML chunk");
    if (type === RES_STRING_POOL) strings = readStringPool(view, at);
    else if (type === RES_XML_RESOURCE_MAP) {
      resourceIds = [];
      for (let p = at + headerSize; p + 4 <= at + size; p += 4) resourceIds.push(view.getUint32(p, true));
    } else if (type === RES_XML_START_ELEMENT) {
      const body = at + headerSize;
      const name = strings[view.getUint32(body + 4, true)] ?? "";
      const attrStart = view.getUint16(body + 8, true);
      const attrSize = view.getUint16(body + 10, true) || 20;
      const attrCount = view.getUint16(body + 12, true);
      const el: AxmlElement = { name, attrs: {}, children: [] };
      for (let i = 0; i < attrCount; i++) {
        const a = body + attrStart + i * attrSize;
        const nameIdx = view.getUint32(a + 4, true);
        const attrName = strings[nameIdx] || ATTR_IDS[resourceIds[nameIdx] ?? -1] || `attr${nameIdx}`;
        const raw = view.getUint32(a + 8, true);
        const dataType = view.getUint8(a + 15);
        const data = view.getUint32(a + 16, true);
        let value: string | number | boolean;
        if (dataType === TYPE_STRING) value = strings[data] ?? "";
        else if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) value = data | 0;
        else if (dataType === TYPE_BOOLEAN) value = data !== 0;
        else value = raw !== 0xffffffff ? (strings[raw] ?? data) : data;
        el.attrs[attrName] = value;
      }
      stack[stack.length - 1]!.children.push(el);
      stack.push(el);
    } else if (type === RES_XML_END_ELEMENT) {
      if (stack.length > 1) stack.pop();
    }
    at += size;
  }
  const manifest = root.children[0];
  if (!manifest) throw new Error("Empty binary XML document");
  return manifest;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) =>
  typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;

export function readAndroidManifest(bytes: Uint8Array): AndroidManifestInfo {
  const manifest = parseAxml(bytes);
  if (manifest.name !== "manifest") throw new Error("AndroidManifest.xml has no <manifest> root");
  const pkg = str(manifest.attrs.package);
  const info: AndroidManifestInfo = {
    package: pkg,
    versionName: str(manifest.attrs.versionName),
    versionCode: num(manifest.attrs.versionCode),
  };
  const sdk = manifest.children.find((c) => c.name === "uses-sdk");
  if (sdk) {
    info.minSdk = num(sdk.attrs.minSdkVersion);
    info.targetSdk = num(sdk.attrs.targetSdkVersion);
  }
  const app = manifest.children.find((c) => c.name === "application");
  for (const activity of app?.children ?? []) {
    if (activity.name !== "activity" && activity.name !== "activity-alias") continue;
    const launcher = activity.children.some(
      (f) =>
        f.name === "intent-filter" &&
        f.children.some((c) => c.name === "action" && c.attrs.name === "android.intent.action.MAIN") &&
        f.children.some((c) => c.name === "category" && c.attrs.name === "android.intent.category.LAUNCHER"),
    );
    const name = str(activity.attrs.name);
    if (launcher && name) {
      info.launcher =
        name.startsWith(".") && pkg ? pkg + name : name.includes(".") || !pkg ? name : `${pkg}.${name}`;
      break;
    }
  }
  return info;
}
