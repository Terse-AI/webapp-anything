import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { readBundleManifest } from "../build/bundle.js";
import { bundleHeaders } from "../build/manifest.js";
import { resolveInside } from "../util/paths.js";
import { bundlePathFor, sendFile } from "./static.js";

/** Serve one bundle folder locally with the headers its manifest asks for. */
export async function startPreview(
  dir: string,
  options: { port?: number; host?: string } = {},
): Promise<{ server: Server; url: string }> {
  const root = path.resolve(dir);
  const manifest = await readBundleManifest(root);
  if (manifest.type !== "static") {
    throw new Error("This bundle is a container project; run `docker compose up --build` inside it instead.");
  }
  const headers = bundleHeaders(manifest);
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const rel = bundlePathFor(url.pathname);
      let file: string | undefined;
      if (rel) {
        try {
          file = resolveInside(root, rel);
        } catch {
          file = undefined;
        }
      }
      const st = file ? await stat(file).catch(() => undefined) : undefined;
      if (!file || !st?.isFile()) {
        // Directory without trailing slash → redirect so relative URLs resolve.
        const dirStat = file ? await stat(file).catch(() => undefined) : undefined;
        if (dirStat?.isDirectory()) {
          res.writeHead(301, { Location: `${url.pathname}/` }).end();
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...headers }).end("Not found");
        return;
      }
      await sendFile(
        req,
        res,
        {
          file,
          size: st.size,
          etag: `${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}`,
          name: rel!,
        },
        { headers, immutable: rel!.startsWith("runtime/") },
      );
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
      else res.destroy();
    }
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4173, host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : options.port;
  return { server, url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/` };
}
