import type { ByteSource } from "../util/bytes.js";
import { Reader } from "../util/bytes.js";
import { UserError } from "../util/errors.js";
import { safeRelativePath } from "../util/paths.js";

export interface AsarFile {
  path: string;
  size: number;
  /** Absolute byte offset of the file data inside the archive. */
  offset: number;
  /** Stored outside the archive in `app.asar.unpacked/`. */
  unpacked: boolean;
}

interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
}

export function looksLikeAsar(head: Uint8Array): boolean {
  const r = new Reader(head);
  return r.u32(0) === 4 && r.ascii(16, 9) === '{"files":';
}

/** Parse an Electron asar archive header. */
export async function readAsar(src: ByteSource): Promise<AsarFile[]> {
  const head = new Reader(await src.read(0, 16));
  if (head.u32(0) !== 4) throw new UserError("Not an asar archive.");
  const headerSize = head.u32(4)!;
  const jsonLen = head.u32(12)!;
  if (jsonLen > 64 * 1024 * 1024) throw new UserError("asar header is unreasonably large.");
  const json = new TextDecoder().decode(await src.read(16, jsonLen));
  let root: AsarNode;
  try {
    root = JSON.parse(json) as AsarNode;
  } catch {
    throw new UserError("Corrupt asar header.");
  }
  const base = 8 + headerSize;
  const out: AsarFile[] = [];
  const walk = (node: AsarNode, prefix: string) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, rel);
      else if (child.link === undefined) {
        const safe = safeRelativePath(rel);
        if (!safe) continue;
        out.push({
          path: safe,
          size: child.size ?? 0,
          offset: base + Number(child.offset ?? 0),
          unpacked: child.unpacked === true,
        });
      }
    }
  };
  walk(root, "");
  return out;
}
