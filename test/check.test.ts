import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as fx from "../scripts/fixtures.mjs";
import { findChrome } from "../src/browser/chrome.js";
import { buildApp } from "../src/build/build.js";
import { checkTarget } from "../src/check/check.js";
import { diffImages, similarity } from "../src/check/diff.js";
import { crop, decodePng, encodePng, type Image } from "../src/check/png.js";
import { eventsToScenario, recordScenario } from "../src/check/record.js";
import { defaultScenario, parseScenario } from "../src/check/scenario.js";
import { RuntimeCache } from "../src/runtimes/cache.js";
import { tempDir, writeFileTemp } from "./helpers.js";

function solid(width: number, height: number, rgb: [number, number, number]): Image {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}

describe("png", () => {
  it("round-trips RGBA pixels", () => {
    const img = solid(7, 5, [10, 200, 30]);
    img.data.set([255, 0, 0, 128], 4 * 12);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(7);
    expect(back.height).toBe(5);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });

  it("crops inside the image bounds", () => {
    const img = solid(10, 10, [1, 2, 3]);
    const c = crop(img, 8, 8, 5, 5);
    expect([c.width, c.height]).toEqual([2, 2]);
  });

  it("rejects non-PNG data", () => {
    expect(() => decodePng(new Uint8Array(20))).toThrow(/Not a PNG/);
  });
});

describe("diff", () => {
  it("counts pixels that changed beyond the tolerance", () => {
    const a = solid(10, 10, [0, 0, 0]);
    const b = solid(10, 10, [0, 0, 0]);
    b.data.set([255, 255, 255, 255], 0);
    b.data.set([10, 10, 10, 255], 4); // under tolerance
    const r = diffImages(a, b);
    expect(r.differentPixels).toBe(1);
    expect(r.mismatch).toBeCloseTo(0.01);
    expect(diffImages(a, solid(5, 5, [0, 0, 0])).sameSize).toBe(false);
  });

  it("scores similarity independent of size", () => {
    const left = solid(200, 150, [0, 0, 0]);
    for (let y = 0; y < 150; y++)
      for (let x = 0; x < 100; x++) left.data.set([255, 255, 255, 255], (y * 200 + x) * 4);
    const scaled = solid(400, 300, [0, 0, 0]);
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 200; x++) scaled.data.set([255, 255, 255, 255], (y * 400 + x) * 4);
    const inverted = solid(200, 150, [255, 255, 255]);
    for (let y = 0; y < 150; y++)
      for (let x = 0; x < 100; x++) inverted.data.set([0, 0, 0, 255], (y * 200 + x) * 4);
    expect(similarity(left, scaled)).toBeGreaterThan(0.95);
    expect(similarity(left, inverted)).toBeLessThan(similarity(left, scaled));
  });
});

describe("scenario", () => {
  it("validates steps", () => {
    const s = parseScenario({
      schema: 1,
      viewport: { width: 800, height: 600 },
      steps: [{ do: "start" }, { do: "click", x: 10, y: 20 }, { do: "snapshot", name: "a", region: "stage" }],
    });
    expect(s.steps).toHaveLength(3);
    expect(() => parseScenario({ schema: 1, steps: [{ do: "explode" }] })).toThrow(/steps\[0\]/);
    expect(() => parseScenario({ schema: 1, steps: [{ do: "start" }] })).toThrow(/snapshot/);
    expect(() => parseScenario({ schema: 1, steps: [{ do: "snapshot", name: "../x" }] })).toThrow(/letters/);
    expect(() =>
      parseScenario({
        schema: 1,
        steps: [
          { do: "snapshot", name: "a" },
          { do: "snapshot", name: "a" },
        ],
      }),
    ).toThrow(/twice/);
    expect(defaultScenario().steps.at(-1)).toMatchObject({ do: "snapshot" });
  });

  it("turns recorded input into steps", () => {
    const s = eventsToScenario(
      [
        { t: 1000, type: "start" },
        { t: 9000, type: "click", x: 5, y: 6 },
        { t: 9500, type: "key", key: "A" },
        { t: 9600, type: "key", key: "d" },
        { t: 9700, type: "key", key: "a" },
        { t: 9800, type: "key", key: "Enter" },
        { t: 12000, type: "snapshot" },
      ],
      { width: 800, height: 600 },
    );
    expect(s.steps).toEqual([
      { do: "start" },
      { do: "click", x: 5, y: 6 },
      { do: "sleep", ms: 500 },
      { do: "type", text: "Ada" },
      { do: "key", key: "Enter" },
      { do: "sleep", ms: 2200 },
      { do: "snapshot", name: "shot-1", region: "stage" },
    ]);
  });
});

// Real Chrome + real v86 runtime: skipped where Chrome is not installed (CI runs it on Linux).
const chrome = findChrome();
const runBrowser = !!chrome && process.env.WAA_SKIP_BROWSER_TESTS !== "1";

describe.skipIf(!runBrowser)("in Chrome", () => {
  async function floppyBundle() {
    const out = path.join(await tempDir(), "floppy");
    const cache = new RuntimeCache(process.env.WAA_CACHE_DIR);
    await buildApp(
      { input: await writeFileTemp("boot.img", fx.bootFloppy("BEHAVIOUR CHECK OK")), outDir: out },
      { runtimes: cache },
    );
    return out;
  }

  it("checks a bundle against its baseline", { timeout: 300_000 }, async () => {
    const bundle = await floppyBundle();
    const dir = await tempDir();
    const scenario = defaultScenario(4000);
    const first = await checkTarget(bundle, scenario, {
      baselineDir: path.join(dir, "base"),
      outDir: path.join(dir, "run1"),
    });
    expect(first.results[0]?.status).toBe("new");
    const second = await checkTarget(bundle, scenario, {
      baselineDir: path.join(dir, "base"),
      outDir: path.join(dir, "run2"),
    });
    expect(second.passed).toBe(true);
    expect(second.results[0]?.mismatch).toBeLessThan(0.01);
    const png = decodePng(new Uint8Array(await readFile(path.join(dir, "base", "started.png"))));
    expect(png.width).toBe(800);
  });

  it("records input as a scenario", { timeout: 300_000 }, async () => {
    const bundle = await floppyBundle();
    const session = await recordScenario(bundle, { headless: true });
    const { page } = session;
    const [x, y] = await page.evaluate<[number, number]>(
      `(() => { const r = document.getElementById("waa-play").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
    );
    await page.click(x, y);
    await page.waitFor(`document.getElementById("waa-overlay").dataset.state === "ready"`, 120_000);
    await page.click(100, 200);
    await page.typeText("hi");
    await page.pressKey("F2");
    await new Promise((r) => setTimeout(r, 500));
    session.stop();
    const scenario = await session.done;
    expect(scenario.steps[0]).toEqual({ do: "start" });
    expect(scenario.steps).toContainEqual({ do: "click", x: 100, y: 200 });
    expect(scenario.steps).toContainEqual({ do: "type", text: "hi" });
    expect(scenario.steps.at(-1)).toEqual({ do: "snapshot", name: "shot-1", region: "stage" });
  });
});
