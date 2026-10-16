import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import * as fx from "../scripts/fixtures.mjs";
import { Browser, type Page } from "../src/browser/cdp.js";
import { findChrome } from "../src/browser/chrome.js";
import { buildApp } from "../src/build/build.js";
import { publishBundle } from "../src/publish/index.js";
import { RuntimeCache } from "../src/runtimes/cache.js";
import { newSyncCode, SYNC_CODE_RE } from "../src/server/saves.js";
import { type RunningServer, startServer } from "../src/server/server.js";
import { FakeRuntimes, tempDir, writeFileTemp } from "./helpers.js";

const TOKEN = "test-token-0123456789abcdef";
let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serverWithApp(runtimes = new FakeRuntimes("/tmp/never")) {
  running = await startServer({ port: 0, dataDir: await tempDir("waa-data-"), token: TOKEN, runtimes });
  const out = path.join(await tempDir(), "bundle");
  const realRuntimes =
    runtimes instanceof FakeRuntimes ? new FakeRuntimes(await tempDir("waa-rt-")) : runtimes;
  await buildApp(
    { input: await writeFileTemp("COUNTER.COM", fx.counterCom()), outDir: out },
    { runtimes: realRuntimes },
  );
  const { url } = await publishBundle(out, {
    to: "server",
    server: running.url,
    token: TOKEN,
    slug: "counter",
  });
  return { base: running.url, appUrl: url };
}

const waas = (payload: string) => {
  const header = new TextEncoder().encode(JSON.stringify({ format: "waa-save", version: 1, backend: "dos" }));
  const out = new Uint8Array(8 + header.length + payload.length);
  out.set([0x57, 0x41, 0x41, 0x53]);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  out.set(new TextEncoder().encode(payload), 8 + header.length);
  return out;
};

describe("sync codes", () => {
  it("are 100-bit base32 groups", () => {
    const code = newSyncCode();
    expect(code).toMatch(SYNC_CODE_RE);
    expect(newSyncCode()).not.toBe(code);
  });
});

describe("save API", () => {
  it("announces itself to apps and stores saves per code", async () => {
    const { base, appUrl } = await serverWithApp();
    const sync = (await (await fetch(`${appUrl}waa-sync.json`)).json()) as { endpoint: string };
    expect(sync.endpoint).toBe(`${base}/api/saves/counter`);

    const created = await fetch(sync.endpoint, { method: "POST" });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };
    expect(code).toMatch(SYNC_CODE_RE);

    expect((await fetch(`${sync.endpoint}/${code}`)).status).toBe(404);
    expect((await fetch(`${sync.endpoint}/${code}`, { method: "PUT", body: "nope" })).status).toBe(422);
    const put = await fetch(`${sync.endpoint}/${code}`, { method: "PUT", body: waas("level 3") });
    expect(put.status).toBe(200);
    const { updatedAt } = (await put.json()) as { updatedAt: number };
    const got = await fetch(`${sync.endpoint}/${code}`);
    expect(got.status).toBe(200);
    expect(Number(got.headers.get("x-waa-updated-at"))).toBe(updatedAt);
    expect(new TextDecoder().decode(new Uint8Array(await got.arrayBuffer())).endsWith("level 3")).toBe(true);

    const second = await fetch(`${sync.endpoint}/${code}`, { method: "PUT", body: waas("level 4") });
    expect(((await second.json()) as { updatedAt: number }).updatedAt).toBeGreaterThan(updatedAt);

    const unknown = newSyncCode();
    expect((await fetch(`${sync.endpoint}/${unknown}`, { method: "PUT", body: waas("x") })).status).toBe(404);
    expect((await fetch(`${sync.endpoint}/not-a-code`)).status).toBe(400);
    expect((await fetch(`${base}/api/saves/missing-app`, { method: "POST" })).status).toBe(404);

    // Deleting the app deletes its saves.
    await fetch(`${base}/api/apps/counter`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect((await fetch(`${sync.endpoint}/${code}`)).status).toBe(404);
  });

  it("answers CORS preflights from app origins", async () => {
    running = await startServer({
      port: 0,
      dataDir: await tempDir("waa-data-"),
      token: TOKEN,
      runtimes: new FakeRuntimes(await tempDir()),
      appOrigin: "https://{slug}.apps.example",
      publicUrl: "https://waa.example",
    });
    const addr = running.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const pre = await fetch(`http://127.0.0.1:${port}/api/saves/x`, {
      method: "OPTIONS",
      headers: { Origin: "https://x.apps.example", "Access-Control-Request-Method": "PUT" },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://x.apps.example");
    const evil = await fetch(`http://127.0.0.1:${port}/api/saves/x`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "PUT" },
    });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});

const chrome = findChrome();
const runBrowser = !!chrome && process.env.WAA_SKIP_BROWSER_TESTS !== "1";

describe.skipIf(!runBrowser)("saved games in Chrome", () => {
  async function play(browser: Browser, url: string, before?: (page: Page) => Promise<void>) {
    const page = await browser.newPage({ width: 800, height: 600 });
    await page.goto(url);
    if (before) await before(page);
    const [x, y] = await page.evaluate<[number, number]>(
      `(() => { const r = document.getElementById("waa-play").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
    );
    await page.click(x, y);
    await page.waitFor(`document.getElementById("waa-overlay").dataset.state === "ready"`, 120_000);
    await new Promise((r) => setTimeout(r, 4000));
    return page;
  }

  async function counterIn(page: Page): Promise<number> {
    const bytes = await page.evaluate<number[]>(`WAA.saves.exportFile().then((b) => Array.from(b || []))`);
    const save = Uint8Array.from(bytes);
    const len = new DataView(save.buffer).getUint32(4, true);
    const changes = unzipSync(save.subarray(8 + len));
    const name = Object.keys(changes).find((n) => n.toUpperCase().endsWith("COUNTER.DAT"));
    expect(name).toBeDefined();
    return changes[name!]![0]!;
  }

  it("restores a whole PC from a v86 machine-state save", { timeout: 300_000 }, async () => {
    const out = path.join(await tempDir(), "floppy");
    await buildApp(
      { input: await writeFileTemp("boot.img", fx.bootFloppy("STATE SAVED BY DEVICE A")), outDir: out },
      { runtimes: new RuntimeCache(process.env.WAA_CACHE_DIR) },
    );
    const { url, server } = await (await import("../src/check/runner.js")).resolveTarget(out);
    const browserA = await Browser.launch();
    let save: number[];
    try {
      const page = await play(browserA, url);
      save = await page.evaluate<number[]>(`WAA.saves.exportFile().then((b) => Array.from(b))`);
      expect(save.length).toBeGreaterThan(1_000_000);
    } finally {
      await browserA.close();
    }
    const browserB = await Browser.launch();
    try {
      const page = await browserB.newPage({ width: 800, height: 600 });
      await page.goto(url);
      await page.evaluate(`WAA.saves.importFile(new Uint8Array(${JSON.stringify(save)}))`);
      const [x, y] = await page.evaluate<[number, number]>(
        `(() => { const r = document.getElementById("waa-play").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
      );
      await page.click(x, y);
      await page.waitFor(`document.getElementById("waa-overlay").dataset.state === "ready"`, 120_000);
      // Restored machines skip the BIOS and show the saved screen straight away.
      await page.waitFor(
        `document.getElementById("screen_container").textContent.includes("STATE SAVED BY DEVICE A")`,
        30_000,
      );
    } finally {
      await browserB.close();
      server?.close();
    }
  });

  it("exports and restores Flash SharedObjects", { timeout: 300_000 }, async () => {
    const out = path.join(await tempDir(), "flash");
    await buildApp(
      { input: await writeFileTemp("game.swf", fx.swfMovie({ frames: 2 })), outDir: out },
      { runtimes: new RuntimeCache(process.env.WAA_CACHE_DIR) },
    );
    const { url, server } = await (await import("../src/check/runner.js")).resolveTarget(out);
    const browser = await Browser.launch({ gpu: true });
    try {
      const page = await browser.newPage({ width: 800, height: 600 });
      await page.goto(url);
      // What Ruffle writes for SharedObject.getLocal("progress") in this movie.
      const key = await page.evaluate<string>(
        `location.hostname + new URL("app/game.swf", location.href).pathname + "/progress"`,
      );
      await page.evaluate(
        `localStorage.setItem(${JSON.stringify(key)}, "AAAA"); localStorage.setItem("other-app", "x")`,
      );
      const save = await page.evaluate<number[]>(`WAA.saves.exportFile().then((b) => Array.from(b))`);
      await page.evaluate(`localStorage.clear()`);
      await page.evaluate(`WAA.saves.importFile(new Uint8Array(${JSON.stringify(save)}))`);
      expect(await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(key)})`)).toBe("AAAA");
      expect(await page.evaluate<string | null>(`localStorage.getItem("other-app")`)).toBeNull();
    } finally {
      await browser.close();
      server?.close();
    }
  });

  it("continues a DOS program's progress on another device", { timeout: 600_000 }, async () => {
    const { appUrl } = await serverWithApp(new RuntimeCache(process.env.WAA_CACHE_DIR) as never);
    const deviceA = await Browser.launch();
    let code: string;
    try {
      const page = await play(deviceA, appUrl);
      expect(await counterIn(page)).toBe(1);
      code = await page.evaluate<string>(`(async () => {
        const info = await (await fetch("waa-sync.json")).json();
        const { code } = await (await fetch(info.endpoint, { method: "POST" })).json();
        WAA.saves.connect(code);
        await WAA.saves.push();
        return code;
      })()`);
      expect(code).toMatch(SYNC_CODE_RE);
    } finally {
      await deviceA.close();
    }
    // A fresh browser profile is a different device: nothing local, only the sync code.
    const deviceB = await Browser.launch();
    try {
      const page = await play(deviceB, appUrl, async (p) => {
        await p.evaluate(`WAA.saves.connect(${JSON.stringify(code)})`);
      });
      expect(await counterIn(page)).toBe(2);
    } finally {
      await deviceB.close();
    }
  });
});
