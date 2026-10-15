const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".jsdos": "application/zip",
  ".jar": "application/java-archive",
  ".swf": "application/x-shockwave-flash",
  ".tar": "application/x-tar",
  ".pdf": "application/pdf",
};

export function contentType(file: string): string {
  const i = file.lastIndexOf(".");
  const ext = i >= 0 ? file.slice(i).toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** Types we may compress on the fly. */
export function isCompressible(type: string): boolean {
  return /^(text\/|application\/(json|javascript|manifest\+json|xml|wasm)|image\/svg)/.test(type);
}
