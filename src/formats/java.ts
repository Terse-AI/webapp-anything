import { Reader } from "../util/bytes.js";

/** Parse a JAR manifest (handles 72-byte line continuations). */
export function parseManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let current: string | undefined;
  for (const line of lines) {
    if (line.startsWith(" ") && current) {
      out[current] += line.slice(1);
      continue;
    }
    if (line.trim() === "") {
      // Only the main section matters for launching.
      if (Object.keys(out).length > 0) break;
      continue;
    }
    const i = line.indexOf(":");
    if (i <= 0) continue;
    current = line.slice(0, i).trim();
    out[current] = line.slice(i + 1).trim();
  }
  return out;
}

/** Class-file major version → Java release (52 → 8, 55 → 11, 61 → 17, 65 → 21). */
export function classFileJavaVersion(bytes: Uint8Array): number | undefined {
  const r = new Reader(bytes);
  if (r.u32(0, false) !== 0xcafebabe) return undefined;
  const major = r.u16(6, false);
  if (major === undefined || major < 45) return undefined;
  return major <= 48 ? 1 : major - 44;
}
