import path from "node:path";

/**
 * Normalise an archive/bundle path to a safe relative POSIX path.
 * Returns null for anything that could escape its root (absolute paths, `..`,
 * drive letters, NUL bytes) so callers can reject the entry.
 */
export function safeRelativePath(input: string): string | null {
  if (!input || input.includes("\0")) return null;
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
  const parts: string[] = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}

/** Join a safe relative POSIX path onto a native root directory. */
export function resolveInside(root: string, rel: string): string {
  const safe = safeRelativePath(rel);
  if (!safe) throw new Error(`Unsafe path: ${JSON.stringify(rel)}`);
  const full = path.resolve(root, ...safe.split("/"));
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new Error(`Path escapes root: ${JSON.stringify(rel)}`);
  }
  return full;
}

export function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function posixBasename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

export function extname(p: string): string {
  const base = posixBasename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

/** URL-safe slug, 1–63 chars, lowercase. */
export function slugify(input: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return s || "app";
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}
