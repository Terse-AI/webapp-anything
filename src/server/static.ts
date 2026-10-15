import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { contentType, isCompressible } from "./mime.js";

export interface StaticFile {
  /** Absolute path of the bytes on disk. */
  file: string;
  size: number;
  /** Strong validator (content hash or mtime+size). */
  etag: string;
  /** Logical path inside the bundle; decides content type and caching. */
  name: string;
}

export interface ServeOptions {
  headers?: Record<string, string>;
  /** Long-lived immutable caching (versioned runtime files). */
  immutable?: boolean;
}

function parseRange(header: string, size: number): { start: number; end: number } | "invalid" | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === "" && b === "") return "invalid";
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/** Send one file with ETag, Range and gzip support. */
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  f: StaticFile,
  options: ServeOptions = {},
) {
  const type = contentType(f.name);
  const gzip =
    !req.headers.range &&
    isCompressible(type) &&
    f.size > 1024 &&
    /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  // Compressed and identity responses are different representations, so they get different tags.
  const etag = gzip ? `"${f.etag}-gz"` : `"${f.etag}"`;
  const headers: Record<string, string> = {
    "Content-Type": type,
    ETag: etag,
    "Accept-Ranges": "bytes",
    "Cache-Control": options.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...options.headers,
  };
  if (f.name.endsWith("sw.js")) headers["Service-Worker-Allowed"] = "./";
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  const inm = req.headers["if-none-match"];
  if (inm?.split(",").some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const rangeHeader = req.headers.range;
  if (rangeHeader && f.size > 0) {
    const ifRange = req.headers["if-range"];
    const range = !ifRange || ifRange === `"${f.etag}"` ? parseRange(rangeHeader, f.size) : undefined;
    if (range === "invalid") {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${f.size}`);
      res.end();
      return;
    }
    if (range) {
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${f.size}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
      if (req.method === "HEAD") return void res.end();
      await pipeline(createReadStream(f.file, { start: range.start, end: range.end }), res);
      return;
    }
  }
  res.setHeader("Vary", "Accept-Encoding");
  res.statusCode = 200;
  if (gzip) {
    res.setHeader("Content-Encoding", "gzip");
    if (req.method === "HEAD") return void res.end();
    await pipeline(createReadStream(f.file), createGzip({ level: 6 }), res);
    return;
  }
  res.setHeader("Content-Length", String(f.size));
  if (req.method === "HEAD") return void res.end();
  await pipeline(createReadStream(f.file), res);
}

/** Map a request path to a bundle path ("" → index.html, "dir/" → dir/index.html). */
export function bundlePathFor(urlPath: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes("\0") || p.includes("\\")) return null;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  const joined = parts.join("/");
  if (joined === "" || urlPath.endsWith("/")) return joined ? `${joined}/index.html` : "index.html";
  return joined;
}
