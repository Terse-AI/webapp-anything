import { request } from "node:http";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import * as fx from "../scripts/fixtures.mjs";
import { buildApp } from "../src/build/build.js";
import { publishBundle } from "../src/publish/index.js";
import { type RunningServer, type ServerOptions, startServer } from "../src/server/server.js";
import { bundlePathFor } from "../src/server/static.js";
import { FakeRuntimes, tempDir, writeFileTemp } from "./helpers.js";

const TOKEN = "test-token-0123456789abcdef";
let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(extra: Partial<ServerOptions> = {}) {
  running = await startServer({
    port: 0,
    host: "127.0.0.1",
    dataDir: await tempDir("waa-data-"),
    token: TOKEN,
    runtimes: new FakeRuntimes(await tempDir("waa-rt-")),
    ...extra,
  });
  return running.url;
}

const auth = { Authorization: `Bearer ${TOKEN}` };

async function upload(
  base: string,
  name: string,
  data: Uint8Array | string,
  headers: Record<string, string> = auth,
) {
  return fetch(`${base}/api/uploads?filename=${encodeURIComponent(name)}`, {
    method: "POST",
    headers,
    body: data,
  });
}

async function publish(
  base: string,
  name: string,
  data: Uint8Array | string,
  body: Record<string, unknown> = {},
) {
  const up = (await (await upload(base, name, data)).json()) as { upload: string };
  return fetch(`${base}/api/apps`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ upload: up.upload, ...body }),
  });
}

/** Raw HTTP GET that does not normalise the path (fetch would resolve "..") and can set Host. */
function rawGet(base: string, pathname: string, headers: Record<string, string> = {}) {
  const u = new URL(base);
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: pathname, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("static paths", () => {
  it("maps URLs to bundle files and refuses traversal", () => {
    expect(bundlePathFor("/")).toBe("index.html");
    expect(bundlePathFor("/docs/")).toBe("docs/index.html");
    expect(bundlePathFor("/a%20b.txt")).toBe("a b.txt");
    expect(bundlePathFor("/../etc/passwd")).toBeNull();
    expect(bundlePathFor("/%2e%2e/secret")).toBeNull();
    expect(bundlePathFor("/x%00")).toBeNull();
    expect(bundlePathFor("/%E0%A4%A")).toBeNull();
  });
});

describe("server", () => {
  it("reports health and info without auth", async () => {
    const base = await start();
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ ok: true });
    const info = (await (await fetch(`${base}/api/info`)).json()) as {
      openUploads: boolean;
      backends: unknown[];
    };
    expect(info.openUploads).toBe(false);
    expect(info.backends.length).toBeGreaterThan(5);
    const ui = await fetch(`${base}/`);
    expect(ui.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await ui.text()).toContain("webapp-anything");
  });

  it("requires the token to upload", async () => {
    const base = await start();
    const res = await upload(base, "hello.com", fx.dosCom(), {});
    expect(res.status).toBe(401);
    const wrong = await upload(base, "hello.com", fx.dosCom(), { Authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);
  });

  it("uploads, scans, publishes and serves an app", async () => {
    const base = await start();
    const up = await upload(base, "hello.com", fx.dosCom());
    expect(up.status).toBe(201);
    const scanned = (await up.json()) as {
      scan: { kind: string };
      plan: { chosen: { backend: string } };
      suggested: { slug: string };
    };
    expect(scanned.scan.kind).toBe("dos-program");
    expect(scanned.plan.chosen.backend).toBe("dos");
    expect(scanned.suggested.slug).toBe("hello");

    const res = await publish(base, "hello.com", fx.dosCom(), { title: "My Hello" });
    expect(res.status).toBe(201);
    const app = (await res.json()) as {
      url: string;
      deleteKey: string;
      app: { slug: string; backend: string };
    };
    expect(app.app).toMatchObject({ slug: "my-hello", backend: "dos" });
    expect(app.url).toBe(`${base}/a/my-hello/`);

    const page = await fetch(app.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(await page.text()).toContain("<title>My Hello</title>");

    const rt = await fetch(`${base}/a/my-hello/runtime/js-dos@8.5.0/js-dos.js`);
    expect(rt.headers.get("cache-control")).toContain("immutable");

    const redirect = await fetch(`${base}/a/my-hello`, { redirect: "manual" });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/a/my-hello/");

    expect((await rawGet(base, "/a/my-hello/../../../etc/passwd")).status).toBe(404);
    expect((await fetch(`${base}/a/nope/`)).status).toBe(404);
  });

  it("supports ETags and byte ranges", async () => {
    const base = await start();
    const { url } = (await (await publish(base, "hello.com", fx.dosCom())).json()) as { url: string };
    const first = await fetch(`${url}app/app.jsdos`);
    const etag = first.headers.get("etag")!;
    const size = (await first.arrayBuffer()).byteLength;
    const cached = await fetch(`${url}app/app.jsdos`, { headers: { "If-None-Match": etag } });
    expect(cached.status).toBe(304);
    const part = await fetch(`${url}app/app.jsdos`, { headers: { Range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-9/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(10);
    const bad = await fetch(`${url}app/app.jsdos`, { headers: { Range: `bytes=${size + 10}-` } });
    expect(bad.status).toBe(416);
  });

  it("sends isolation headers only for apps that need them", async () => {
    const base = await start();
    const linux = (await (await publish(base, "hello", fx.linuxHello())).json()) as { url: string };
    const page = await fetch(linux.url);
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(page.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    const dos = (await (await publish(base, "hello.com", fx.dosCom())).json()) as { url: string };
    expect((await fetch(dos.url)).headers.get("cross-origin-embedder-policy")).toBeNull();
  });

  it("protects names and lets owners replace or delete apps", async () => {
    const base = await start();
    const first = (await (await publish(base, "a.com", fx.dosCom(), { slug: "game" })).json()) as {
      deleteKey: string;
    };
    const taken = await publish(base, "b.com", fx.dosCom(), { slug: "game" });
    expect(taken.status).toBe(409);
    const auto = (await (await publish(base, "game.com", fx.dosCom())).json()) as { app: { slug: string } };
    expect(auto.app.slug).toBe("game-2");

    const anonDelete = await fetch(`${base}/api/apps/game`, { method: "DELETE" });
    expect(anonDelete.status).toBe(403);
    const keyDelete = await fetch(`${base}/api/apps/game`, {
      method: "DELETE",
      headers: { "X-App-Key": first.deleteKey },
    });
    expect(keyDelete.status).toBe(200);
    expect((await fetch(`${base}/a/game/`)).status).toBe(404);

    const list = (await (await fetch(`${base}/api/apps`, { headers: auth })).json()) as {
      apps: { slug: string }[];
    };
    expect(list.apps.map((a) => a.slug)).toEqual(["game-2"]);
    expect((await fetch(`${base}/api/apps`)).status).toBe(401);
  });

  it("explains unsupported uploads", async () => {
    const base = await start();
    const ipa = zipSync({ "Payload/Hello.app/Hello": strToU8("x") });
    const up = (await (await upload(base, "app.ipa", ipa)).json()) as {
      upload: string;
      plan: { unsupported: string };
    };
    expect(up.plan.unsupported).toMatch(/iOS/);
    const res = await fetch(`${base}/api/apps`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ upload: up.upload }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/iOS/);

    // Android apps stream from an emulator container, which a static host cannot run.
    const apk = (await (await upload(base, "app.apk", fx.apk())).json()) as {
      upload: string;
      plan: { chosen: { backend: string } };
    };
    expect(apk.plan.chosen.backend).toBe("stream");
    const publish = await fetch(`${base}/api/apps`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ upload: apk.upload }),
    });
    expect(publish.status).toBe(422);
    expect(((await publish.json()) as { error: string }).error).toMatch(/container backend/);
  });

  it("enforces the upload size limit", async () => {
    const base = await start({ maxUploadBytes: 1024 });
    const res = await upload(base, "big.bin", new Uint8Array(4096));
    expect(res.status).toBe(413);
  });

  it("rate-limits anonymous uploads when open", async () => {
    const base = await start({ openUploads: true, uploadsPerHour: 1 });
    expect((await upload(base, "a.com", fx.dosCom(), {})).status).toBe(201);
    expect((await upload(base, "b.com", fx.dosCom(), {})).status).toBe(429);
    // The admin token is never rate limited.
    expect((await upload(base, "c.com", fx.dosCom())).status).toBe(201);
  });

  it("accepts bundles from `waa publish --to server`", async () => {
    const base = await start();
    const out = path.join(await tempDir(), "bundle");
    await buildApp(
      { input: await writeFileTemp("movie.swf", fx.swfMovie({ frames: 2 })), outDir: out },
      { runtimes: new FakeRuntimes(await tempDir()) },
    );
    const res = await publishBundle(out, { to: "server", server: base, token: TOKEN, slug: "movie" });
    expect(res.url).toBe(`${base}/a/movie/`);
    expect((await fetch(`${res.url}app/movie.swf`)).status).toBe(200);
    // Publishing again replaces it in place.
    await publishBundle(out, { to: "server", server: base, token: TOKEN, slug: "movie" });
    await expect(
      publishBundle(out, { to: "server", server: base, token: "wrong-token-000000", slug: "movie" }),
    ).rejects.toThrow(/403|401/);
  });

  it("rejects bundle uploads with unsafe paths or no manifest", async () => {
    const base = await start();
    const put = (body: Uint8Array) =>
      fetch(`${base}/api/apps/evil`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/zip" },
        body,
      });
    expect((await put(zipSync({ "index.html": strToU8("hi") }))).status).toBe(422);
    expect((await put(zipSync({ "../x.html": strToU8("hi"), "waa.json": strToU8("{}") }))).status).toBe(422);
  });

  it("serves apps from per-app origins", async () => {
    const base = await start({ appOrigin: "http://{slug}.apps.test:9999" });
    const res = (await (await publish(base, "hello.com", fx.dosCom())).json()) as { url: string };
    expect(res.url).toBe("http://hello.apps.test:9999/");
    const onAppHost = await rawGet(base, "/", { Host: "hello.apps.test:9999" });
    expect(onAppHost.status).toBe(200);
    expect(onAppHost.body).toContain("<title>Hello</title>");
    // The API is not reachable from app origins.
    expect((await rawGet(base, "/api/apps", { Host: "hello.apps.test:9999" })).status).toBe(404);
    const redirect = await rawGet(base, "/a/hello/");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("http://hello.apps.test:9999/");
  });
});
