import { stat } from "node:fs/promises";
import type { Server } from "node:http";
import { Browser, type Page } from "../browser/cdp.js";
import { startPreview } from "../server/preview.js";
import { type Logger, silentLogger } from "../util/log.js";
import { crop, decodePng, encodePng, type Image } from "./png.js";
import type { Region, Scenario } from "./scenario.js";

export interface Snapshot {
  name: string;
  image: Image;
  png: Uint8Array;
  threshold?: number;
}

export interface RunOptions {
  log?: Logger;
  /** Use the GPU instead of SwiftShader (Flash under Ruffle warns without it). */
  gpu?: boolean;
  /** Reuse a running browser. */
  browser?: Browser;
  /** Collect uncaught exceptions and console errors from the page here. */
  errors?: string[];
}

const READY = `document.getElementById("waa-overlay")?.dataset.state === "ready"`;
const FAILED = `document.getElementById("waa-overlay")?.dataset.state === "error"`;

/** A target is a bundle folder (served on a temporary local port) or an http(s) URL. */
export async function resolveTarget(target: string): Promise<{ url: string; server?: Server }> {
  if (/^https?:\/\//i.test(target)) return { url: target };
  const st = await stat(target).catch(() => undefined);
  if (!st?.isDirectory()) throw new Error(`${target} is neither a URL nor a bundle folder.`);
  const { server, url } = await startPreview(target, { port: 0 });
  return { url, server };
}

async function regionRect(
  page: Page,
  region: Region | undefined,
): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  if (!region || region === "page") return undefined;
  if (region === "stage") {
    return page.evaluate<{ x: number; y: number; width: number; height: number } | undefined>(
      `(() => { const el = document.getElementById("waa-stage"); if (!el) return undefined; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
  }
  return region;
}

async function startPlayer(page: Page, timeoutMs: number): Promise<void> {
  const hasPlayer = await page.evaluate<boolean>(`!!document.getElementById("waa-play")`);
  if (!hasPlayer) return;
  const autostart = await page.evaluate<boolean>(
    `!!(window.WAA && window.WAA.config && window.WAA.config.autostart)`,
  );
  if (!autostart) {
    const [x, y] = await page.evaluate<[number, number]>(
      `(() => { const r = document.getElementById("waa-play").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
    );
    await page.click(x, y);
  }
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate<boolean>(READY).catch(() => false)) return;
    if (await page.evaluate<boolean>(FAILED).catch(() => false)) {
      const message = await page.evaluate<string>(
        `document.getElementById("waa-error")?.textContent || "unknown error"`,
      );
      throw new Error(`The app failed to start: ${message}`);
    }
    if (Date.now() > end)
      throw new Error(`The app did not become ready within ${Math.round(timeoutMs / 1000)}s.`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Run a scenario against a URL and return its snapshots. */
export async function runScenario(
  url: string,
  scenario: Scenario,
  options: RunOptions = {},
): Promise<Snapshot[]> {
  const log = options.log ?? silentLogger;
  const browser =
    options.browser ?? (await Browser.launch({ gpu: options.gpu, windowSize: scenario.viewport }));
  const page = await browser.newPage(scenario.viewport);
  const snapshots: Snapshot[] = [];
  const errors = options.errors;
  const unsubscribe = errors
    ? [
        page.on("Runtime.exceptionThrown", (p) => {
          const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
          errors.push(d?.exception?.description ?? d?.text ?? "Uncaught exception");
        }),
        page.on("Runtime.consoleAPICalled", (p) => {
          if (p.type !== "error") return;
          const args = (p.args as { value?: unknown; description?: string }[] | undefined) ?? [];
          errors.push(`console.error: ${args.map((a) => a.description ?? String(a.value)).join(" ")}`);
        }),
      ]
    : [];
  try {
    await page.goto(url);
    for (const step of scenario.steps) {
      switch (step.do) {
        case "start":
          log.info("  starting the app…");
          await startPlayer(page, step.timeoutMs ?? 180_000);
          break;
        case "sleep":
          await new Promise((r) => setTimeout(r, step.ms));
          break;
        case "waitFor":
          await page.waitFor(step.js, step.timeoutMs ?? 60_000);
          break;
        case "click":
          await page.click(step.x, step.y);
          break;
        case "move":
          await page.mouseMove(step.x, step.y);
          break;
        case "type":
          await page.typeText(step.text);
          break;
        case "key":
          await page.pressKey(step.key);
          break;
        case "snapshot": {
          const rect = await regionRect(page, step.region);
          const scale = scenario.viewport.scale ?? 1;
          const full = decodePng(await page.screenshot());
          const image = rect
            ? crop(full, rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale)
            : full;
          snapshots.push({ name: step.name, image, png: encodePng(image), threshold: step.threshold });
          log.info(`  snapshot ${step.name} (${image.width}×${image.height})`);
          break;
        }
      }
    }
    return snapshots;
  } finally {
    for (const off of unsubscribe) off();
    await page.close();
    if (!options.browser) await browser.close();
  }
}
