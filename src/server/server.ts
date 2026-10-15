import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BACKENDS, planFor } from "../backends/index.js";
import { buildApp, defaultTitle } from "../build/build.js";
import { readBundleManifest } from "../build/bundle.js";
import { type BackendId, bundleHeaders, MANIFEST_FILE } from "../build/manifest.js";
import { readZipDirectory, readZipEntry } from "../formats/zip.js";
import { RuntimeCache, type RuntimeProvider } from "../runtimes/cache.js";
import { scanInput } from "../scan/scan.js";
import { assetPath, packageVersion } from "../util/assets.js";
import { fileSource } from "../util/bytes.js";
import { errorMessage, UserError } from "../util/errors.js";
import { type Logger, silentLogger } from "../util/log.js";
import { isValidSlug, resolveInside, safeRelativePath, slugify } from "../util/paths.js";
import { bundlePathFor, sendFile } from "./static.js";
import { AppStore, hashKey, publicApp } from "./store.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir: string;
  /** Admin/publish token. Generated (and saved in the data folder) when omitted. */
  token?: string;
  publicUrl?: string;
  /** Serve apps from a different origin: "https://apps.example.com" or "https://{slug}.apps.example.com". */
  appOrigin?: string;
  maxUploadBytes?: number;
  openUploads?: boolean;
  /** Anonymous uploads allowed per IP per hour when openUploads is on. */
  uploadsPerHour?: number;
  buildConcurrency?: number;
  log?: Logger;
  runtimes?: RuntimeProvider;
}

export interface RunningServer {
  server: Server;
  url: string;
  token: string;
  generatedToken: boolean;
  store: AppStore;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const UPLOAD_TTL_MS = 60 * 60 * 1000;
const UI_FILES: Record<string, string> = {
  "/": "ui/index.html",
  "/ui/app.js": "ui/app.js",
  "/ui/style.css": "ui/style.css",
  "/ui/icon.svg": "player/icon.svg",
};
const UI_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim();
}

async function loadOrCreateToken(
  dataDir: string,
  given?: string,
): Promise<{ token: string; generated: boolean }> {
  if (given) {
    if (given.length < 16) throw new UserError("The publish token must be at least 16 characters.");
    return { token: given, generated: false };
  }
  const file = path.join(dataDir, "token");
  try {
    const t = (await readFile(file, "utf8")).trim();
    if (t) return { token: t, generated: false };
  } catch {
    // create below
  }
  const token = randomBytes(24).toString("base64url");
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return { token, generated: true };
}

/** Stream a request body to a file, enforcing a size limit. */
async function receiveToFile(req: IncomingMessage, dest: string, limit: number): Promise<number> {
  const declared = Number(req.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, `Upload is larger than the ${Math.round(limit / 1048576)} MB limit.`);
  }
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > limit)
        cb(new HttpError(413, `Upload is larger than the ${Math.round(limit / 1048576)} MB limit.`));
      else cb(null, chunk);
    },
  });
  await pipeline(req, counter, createWriteStream(dest));
  if (received === 0) throw new HttpError(400, "The upload is empty.");
  return received;
}

async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Expected a JSON object.");
  }
}

function safeFilename(name: string | null | undefined): string {
  const base = (name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .slice(0, 120)
    .trim();
  return clean && clean !== "." && clean !== ".." ? clean : "upload.bin";
}

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.queue.length >= this.maxQueue)
        throw new HttpError(503, "The server is busy building other apps; try again shortly.");
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perHour: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (list.length >= this.perHour) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

interface UploadMeta {
  id: string;
  filename: string;
  file: string;
  size: number;
  createdAt: number;
}

export async function createHandler(o: ServerOptions) {
  const log = o.log ?? silentLogger;
  const dataDir = path.resolve(o.dataDir);
  await mkdir(dataDir, { recursive: true });
  const store = new AppStore(dataDir);
  await store.init();
  const { token, generated } = await loadOrCreateToken(dataDir, o.token);
  const runtimes =
    o.runtimes ?? new RuntimeCache(process.env.WAA_CACHE_DIR ?? path.join(dataDir, "cache"), log);
  const maxUpload = o.maxUploadBytes ?? 1024 * 1024 * 1024;
  const builds = new Semaphore(o.buildConcurrency ?? 2, 32);
  const limiter = new RateLimiter(o.uploadsPerHour ?? 20);
  const uploadsDir = path.join(dataDir, "uploads");
  await rm(uploadsDir, { recursive: true, force: true });
  await mkdir(uploadsDir, { recursive: true });
  const uploads = new Map<string, UploadMeta>();
  const configuredUrl = o.publicUrl?.replace(/\/+$/, "");
  /** External base URL: the configured one, else whatever host the client used to reach us. */
  const baseUrl = (req: IncomingMessage) => {
    if (configuredUrl) return configuredUrl;
    const trustProxy = process.env.WAA_TRUST_PROXY === "1";
    const proto =
      (trustProxy &&
        String(req.headers["x-forwarded-proto"] ?? "")
          .split(",")[0]
          ?.trim()) ||
      "http";
    const host =
      (trustProxy &&
        String(req.headers["x-forwarded-host"] ?? "")
          .split(",")[0]
          ?.trim()) ||
      req.headers.host ||
      "localhost";
    return `${proto === "https" ? "https" : "http"}://${host}`;
  };

  const appOrigin = o.appOrigin?.replace(/\/+$/, "");
  let appHostRe: RegExp | undefined;
  let appFixedHost: string | undefined;
  if (appOrigin) {
    const u = new URL(appOrigin.replace("{slug}", "slug-placeholder"));
    if (appOrigin.includes("{slug}")) {
      const pattern = u.host
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace("slug-placeholder", "([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)");
      appHostRe = new RegExp(`^${pattern}$`, "i");
    } else {
      appFixedHost = u.host.toLowerCase();
    }
  }
  const appUrl = (slug: string, req: IncomingMessage) => {
    if (!appOrigin) return `${baseUrl(req)}/a/${slug}/`;
    if (appOrigin.includes("{slug}")) return `${appOrigin.replace("{slug}", slug)}/`;
    return `${appOrigin}/a/${slug}/`;
  };

  const cleanup = setInterval(
    async () => {
      const now = Date.now();
      for (const [id, u] of uploads) {
        if (now - u.createdAt > UPLOAD_TTL_MS) {
          uploads.delete(id);
          await rm(path.dirname(u.file), { recursive: true, force: true }).catch(() => {});
        }
      }
    },
    10 * 60 * 1000,
  );
  cleanup.unref();

  const isAdmin = (req: IncomingMessage) => {
    const t = bearer(req);
    return !!t && sameSecret(t, token);
  };
  const ownsApp = (req: IncomingMessage, slug: string) => {
    if (isAdmin(req)) return true;
    const rec = store.get(slug);
    const t = bearer(req) ?? (req.headers["x-app-key"] as string | undefined);
    return !!rec && !!t && sameSecret(hashKey(t), rec.keyHash);
  };
  const clientIp = (req: IncomingMessage) =>
    (process.env.WAA_TRUST_PROXY === "1"
      ? String(req.headers["x-forwarded-for"] ?? "")
          .split(",")[0]
          ?.trim()
      : "") ||
    req.socket.remoteAddress ||
    "unknown";
  const requireCreate = (req: IncomingMessage) => {
    if (isAdmin(req)) return;
    if (!o.openUploads)
      throw new HttpError(401, "A publish token is required.", "Send Authorization: Bearer <token>.");
    if (!limiter.take(clientIp(req)))
      throw new HttpError(429, "Too many uploads from your address; try again later.");
  };

  function freeSlug(base: string): string {
    const root = slugify(base).slice(0, 56) || "app";
    if (!store.get(root)) return root;
    for (let i = 2; i < 10_000; i++) {
      const s = `${root}-${i}`;
      if (!store.get(s)) return s;
    }
    return `${root}-${randomBytes(3).toString("hex")}`;
  }

  async function serveApp(
    req: IncomingMessage,
    res: ServerResponse,
    slug: string,
    rest: string,
    prefix: string,
  ) {
    const rec = store.get(slug);
    if (!rec) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("App not found");
      return;
    }
    if (rest === "") {
      res.writeHead(301, { Location: `${prefix}/` }).end();
      return;
    }
    const headers = bundleHeaders(rec.manifest);
    const rel = bundlePathFor(rest);
    if (rel && !rec.files[rel] && rec.files[`${rel}/index.html`]) {
      res.writeHead(301, { Location: `${prefix}${rest}/` }).end();
      return;
    }
    const f = rel ? rec.files[rel] : undefined;
    if (!rel || !f) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...headers }).end("Not found");
      return;
    }
    await sendFile(
      req,
      res,
      { file: store.blobPath(f.hash), size: f.size, etag: f.hash, name: rel },
      { headers, immutable: rel.startsWith("runtime/") },
    );
  }

  async function buildFromFile(
    file: string,
    filename: string,
    params: {
      title?: string;
      slug?: string;
      backend?: string;
      entry?: string;
      autostart?: boolean;
      replace?: boolean;
    },
    req: IncomingMessage,
  ) {
    if (params.backend && !BACKENDS.some((b) => b.id === params.backend))
      throw new HttpError(400, `Unknown backend ${params.backend}.`);
    if (params.slug && !isValidSlug(params.slug)) throw new HttpError(400, "Invalid slug.");
    const title =
      typeof params.title === "string" ? params.title.trim().slice(0, 120) || undefined : undefined;
    return builds.run(async () => {
      let slug = params.slug;
      if (slug && store.get(slug)) {
        if (!params.replace) throw new HttpError(409, `The name "${slug}" is taken.`);
        if (!ownsApp(req, slug)) throw new HttpError(403, "Only the owner can replace this app.");
      }
      const work = await store.tempDir("build");
      try {
        const outDir = path.join(work, "bundle");
        const result = await buildApp(
          {
            input: file,
            displayName: filename,
            outDir,
            backend: params.backend as BackendId | undefined,
            entry: params.entry,
            title,
            slug: slug ?? "app",
            autostart: params.autostart,
          },
          { runtimes, log },
        );
        if (result.manifest.type !== "static") {
          throw new HttpError(
            422,
            "This program needs the container backend, which this server cannot host.",
            "Build it locally with `waa build` and run it with Docker.",
          );
        }
        slug ??= freeSlug(result.manifest.app.title);
        const key = randomBytes(18).toString("base64url");
        const rec = await store.ingest(outDir, slug, result.manifest, hashKey(key));
        log.info("published app", { slug, backend: result.manifest.backend.id, bytes: rec.size });
        return { app: publicApp(rec), url: appUrl(slug, req), deleteKey: key, warnings: result.warnings };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (p === "/api/info" && method === "GET") {
      return sendJson(res, 200, {
        name: "webapp-anything",
        version: packageVersion(),
        openUploads: !!o.openUploads,
        maxUploadBytes: maxUpload,
        backends: BACKENDS.map((b) => ({ id: b.id, title: b.title, runs: b.runs })),
      });
    }
    if (p === "/api/session" && method === "GET") {
      return sendJson(res, 200, { admin: isAdmin(req) });
    }

    if (p === "/api/uploads" && method === "POST") {
      requireCreate(req);
      const filename = safeFilename(url.searchParams.get("filename"));
      const id = randomBytes(12).toString("base64url");
      const dir = path.join(uploadsDir, id);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, filename);
      try {
        const size = await receiveToFile(req, file, maxUpload);
        const { report, tree } = await scanInput(file, { displayName: filename });
        await tree.close();
        uploads.set(id, { id, filename, file, size, createdAt: Date.now() });
        const plan = planFor(report);
        const title = defaultTitle(report);
        return sendJson(res, 201, {
          upload: id,
          scan: report,
          plan,
          suggested: { title, slug: freeSlug(title) },
        });
      } catch (err) {
        await rm(dir, { recursive: true, force: true });
        throw err;
      }
    }

    if (p === "/api/apps" && method === "POST") {
      requireCreate(req);
      const isJson = String(req.headers["content-type"] ?? "").startsWith("application/json");
      if (isJson) {
        const body = await readJsonBody(req);
        const up = typeof body.upload === "string" ? uploads.get(body.upload) : undefined;
        if (!up) throw new HttpError(404, "Upload not found or expired; upload the file again.");
        const result = await buildFromFile(
          up.file,
          up.filename,
          {
            title: typeof body.title === "string" ? body.title : undefined,
            slug: typeof body.slug === "string" && body.slug ? body.slug : undefined,
            backend: typeof body.backend === "string" && body.backend ? body.backend : undefined,
            entry: typeof body.entry === "string" && body.entry ? body.entry : undefined,
            autostart: body.autostart === true,
            replace: body.replace === true,
          },
          req,
        );
        uploads.delete(up.id);
        await rm(path.dirname(up.file), { recursive: true, force: true });
        return sendJson(res, 201, result);
      }
      // One-shot upload: raw body plus query parameters (handy for curl).
      const filename = safeFilename(url.searchParams.get("filename"));
      const work = await store.tempDir("upload");
      try {
        const file = path.join(work, filename);
        await receiveToFile(req, file, maxUpload);
        const q = url.searchParams;
        const result = await buildFromFile(
          file,
          filename,
          {
            title: q.get("title") ?? undefined,
            slug: q.get("slug") || undefined,
            backend: q.get("backend") || undefined,
            entry: q.get("entry") || undefined,
            autostart: q.get("autostart") === "1",
            replace: q.get("replace") === "1",
          },
          req,
        );
        return sendJson(res, 201, result);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }

    if (p === "/api/apps" && method === "GET") {
      if (!isAdmin(req)) throw new HttpError(401, "A publish token is required to list apps.");
      const apps = store.list().map((r) => ({ ...publicApp(r), url: appUrl(r.slug, req) }));
      const stats = store.stats();
      return sendJson(res, 200, { apps, count: stats.apps, bytes: stats.bytes });
    }

    const m = /^\/api\/apps\/([^/]+)$/.exec(p);
    if (m) {
      const slug = decodeURIComponent(m[1]!);
      if (!isValidSlug(slug)) throw new HttpError(400, "Invalid slug.");
      if (method === "GET") {
        const rec = store.get(slug);
        if (!rec) throw new HttpError(404, "App not found.");
        return sendJson(res, 200, { app: publicApp(rec), url: appUrl(slug, req) });
      }
      if (method === "DELETE") {
        if (!store.get(slug)) throw new HttpError(404, "App not found.");
        if (!ownsApp(req, slug)) throw new HttpError(403, "Only the owner can delete this app.");
        await store.delete(slug);
        store.gc().catch((err) => log.warn(`gc failed: ${errorMessage(err)}`));
        log.info("deleted app", { slug });
        return sendJson(res, 200, { deleted: slug });
      }
      if (method === "PUT") {
        const existing = store.get(slug);
        if (existing && !ownsApp(req, slug)) throw new HttpError(403, "Only the owner can replace this app.");
        if (!existing) requireCreate(req);
        return builds.run(async () => {
          const work = await store.tempDir("bundle");
          try {
            const zip = path.join(work, "bundle.zip");
            await receiveToFile(req, zip, maxUpload);
            const dir = path.join(work, "files");
            await extractBundleZip(zip, dir, maxUpload * 4);
            const manifest = await readBundleManifest(dir).catch(() => {
              throw new HttpError(
                422,
                `The upload is not a webapp-anything bundle (missing or invalid ${MANIFEST_FILE}).`,
              );
            });
            if (manifest.type !== "static")
              throw new HttpError(422, "Container bundles cannot be hosted here.");
            const key = existing ? undefined : randomBytes(18).toString("base64url");
            const rec = await store.ingest(dir, slug, manifest, key ? hashKey(key) : existing!.keyHash);
            store.gc().catch(() => {});
            log.info("published bundle", { slug, bytes: rec.size });
            return sendJson(res, existing ? 200 : 201, {
              app: publicApp(rec),
              url: appUrl(slug, req),
              ...(key && !isAdmin(req) ? { deleteKey: key } : {}),
            });
          } finally {
            await rm(work, { recursive: true, force: true });
          }
        });
      }
    }
    throw new HttpError(404, "Not found.");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const host = String(req.headers.host ?? "").toLowerCase();
    const method = req.method ?? "GET";

    // Requests on the dedicated app origin only ever serve app files.
    if (appHostRe || appFixedHost) {
      const hostSlug = appHostRe?.exec(host)?.[1]?.toLowerCase();
      if (hostSlug) return serveApp(req, res, hostSlug, url.pathname, "");
      if (appFixedHost && host === appFixedHost) {
        const am = /^\/a\/([^/]+)(\/.*)?$/.exec(url.pathname);
        if (am) return serveApp(req, res, am[1]!, am[2] ?? "", `/a/${am[1]}`);
        res.writeHead(404).end();
        return;
      }
    }
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, version: packageVersion() });

    const am = /^\/a\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (am) {
      if (method !== "GET" && method !== "HEAD") return void res.writeHead(405, { Allow: "GET, HEAD" }).end();
      if (appOrigin) {
        res.writeHead(302, { Location: `${appUrl(am[1]!, req).replace(/\/$/, "")}${am[2] ?? "/"}` }).end();
        return;
      }
      return serveApp(req, res, am[1]!, am[2] ?? "", `/a/${am[1]}`);
    }
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    const ui = UI_FILES[url.pathname];
    if (ui && (method === "GET" || method === "HEAD")) {
      const file = assetPath(ui);
      const st = await stat(file);
      return sendFile(
        req,
        res,
        { file, size: st.size, etag: `${st.size}-${st.mtimeMs}`, name: ui },
        { headers: UI_HEADERS },
      );
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    try {
      await handle(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof UserError ? 422 : 500;
      const hint = err instanceof HttpError || err instanceof UserError ? err.hint : undefined;
      if (status === 500) log.error(`request failed: ${errorMessage(err)}`, { path: req.url });
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status === 500 ? "Internal server error." : errorMessage(err),
          ...(hint ? { hint } : {}),
        });
      } else res.destroy();
      // Drain any unread body so the connection can be reused or closed cleanly.
      req.resume();
    } finally {
      if (req.url !== "/healthz") {
        log.info(`${req.method} ${req.url?.split("?")[0]} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  };
  return {
    handler,
    store,
    token,
    generatedToken: generated,
    dispose: () => clearInterval(cleanup),
  };
}

/** Extract an uploaded bundle zip into `dir`, rejecting unsafe paths and zip bombs. */
export async function extractBundleZip(zip: string, dir: string, maxBytes: number): Promise<void> {
  const src = await fileSource(zip);
  try {
    const entries = await readZipDirectory(src, { maxEntries: 50_000 });
    let total = 0;
    for (const e of entries) {
      if (e.isDirectory) continue;
      if (!e.path) throw new HttpError(422, `Unsafe path in bundle: ${e.rawName}`);
      const safe = safeRelativePath(e.path);
      if (!safe) throw new HttpError(422, `Unsafe path in bundle: ${e.rawName}`);
      total += e.size;
      if (total > maxBytes) throw new HttpError(413, "Bundle expands beyond the size limit.");
      const dest = resolveInside(dir, safe);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, await readZipEntry(src, e));
    }
    const items = await readdir(dir).catch(() => [] as string[]);
    if (!items.includes(MANIFEST_FILE))
      throw new HttpError(422, `The bundle has no ${MANIFEST_FILE} at its root.`);
  } finally {
    await src.close();
  }
}

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const port = o.port ?? 8080;
  const host = o.host ?? "127.0.0.1";
  const server = createServer();
  let actualPort = port;
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const app = await createHandler(o);
  server.on("request", (req, res) => {
    void app.handler(req, res);
  });
  server.requestTimeout = 60 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) actualPort = addr.port;
  const url = o.publicUrl ?? `http://${displayHost}:${actualPort}`;
  const close = () =>
    new Promise<void>((resolve) => {
      app.dispose();
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  return { server, url, token: app.token, generatedToken: app.generatedToken, store: app.store, close };
}

/** Close the server cleanly on SIGTERM/SIGINT (used by the CLI). */
export function closeOnSignals(running: RunningServer, log?: Logger): void {
  const onSignal = () => {
    log?.info("shutting down…");
    const timer = setTimeout(() => process.exit(0), 10_000);
    timer.unref();
    void running.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
