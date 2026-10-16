import { Browser } from "../browser/cdp.js";
import { type Logger, silentLogger } from "../util/log.js";
import { resolveTarget } from "./runner.js";
import type { Scenario, Step } from "./scenario.js";

/** Injected into every frame: reports trusted input to the recorder through a CDP binding. */
const RECORDER = `(() => {
  if (window.__waaRecorderInstalled) return;
  window.__waaRecorderInstalled = true;
  const send = (e) => { try { window.__waaRecord(JSON.stringify({ t: performance.timeOrigin + performance.now(), ...e })); } catch {} };
  addEventListener("pointerdown", (e) => {
    if (!e.isTrusted) return;
    const play = e.target && e.target.closest && e.target.closest("#waa-play");
    send(play ? { type: "start" } : { type: "click", x: Math.round(e.clientX), y: Math.round(e.clientY) });
  }, true);
  addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.repeat) return;
    if (e.key === "F2") { e.preventDefault(); send({ type: "snapshot" }); return; }
    send({ type: "key", key: e.key });
  }, true);
})();`;

export interface RecordedEvent {
  t: number;
  type: "start" | "click" | "key" | "snapshot";
  x?: number;
  y?: number;
  key?: string;
}

const SPECIAL_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "F1",
  "F10",
]);

/** Turn raw input events into scenario steps (typing is merged, pauses become sleeps). */
export function eventsToScenario(events: RecordedEvent[], viewport: Scenario["viewport"]): Scenario {
  const steps: Step[] = [];
  let last: number | undefined;
  let shots = 0;
  const pause = (t: number) => {
    if (last !== undefined) {
      const ms = Math.round((t - last) / 100) * 100;
      if (ms >= 200) steps.push({ do: "sleep", ms: Math.min(ms, 120_000) });
    }
    last = t;
  };
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.type === "start") {
      if (!steps.some((s) => s.do === "start")) steps.push({ do: "start" });
      last = undefined; // time spent loading is covered by "start"
      continue;
    }
    if (e.type === "key" && e.key && e.key.length === 1) {
      const prev = steps.at(-1);
      if (prev?.do === "type" && last !== undefined && e.t - last < 1500) {
        prev.text += e.key;
        last = e.t;
        continue;
      }
      pause(e.t);
      steps.push({ do: "type", text: e.key });
      continue;
    }
    pause(e.t);
    if (e.type === "click" && e.x !== undefined && e.y !== undefined)
      steps.push({ do: "click", x: e.x, y: e.y });
    else if (e.type === "key" && e.key && SPECIAL_KEYS.has(e.key)) steps.push({ do: "key", key: e.key });
    else if (e.type === "key" && e.key === " ") steps.push({ do: "key", key: "Space" });
    else if (e.type === "snapshot") steps.push({ do: "snapshot", name: `shot-${++shots}`, region: "stage" });
  }
  if (!steps.some((s) => s.do === "snapshot")) {
    steps.push({ do: "sleep", ms: 1000 }, { do: "snapshot", name: "end", region: "stage" });
  }
  return { schema: 1, viewport, steps };
}

export interface RecordSession {
  /** Resolves with the scenario once the window closes or stop() is called. */
  done: Promise<Scenario>;
  stop(): void;
  /** For tests: the page being recorded. */
  page: import("../browser/cdp.js").Page;
}

/** Open the target in a visible Chrome window and record what the user does. */
export async function recordScenario(
  target: string,
  options: { viewport?: Scenario["viewport"]; headless?: boolean; log?: Logger } = {},
): Promise<RecordSession> {
  const log = options.log ?? silentLogger;
  const viewport = options.viewport ?? { width: 800, height: 600 };
  const { url, server } = await resolveTarget(target);
  const browser = await Browser.launch({
    headless: options.headless ?? false,
    gpu: !options.headless,
    windowSize: { width: viewport.width + 40, height: viewport.height + 120 },
  });
  const page = await browser.newPage(viewport);
  const events: RecordedEvent[] = [];
  page.on("Runtime.bindingCalled", (p) => {
    if (p.name !== "__waaRecord") return;
    try {
      const e = JSON.parse(String(p.payload)) as RecordedEvent;
      events.push(e);
      if (e.type === "snapshot")
        log.info(`  marked snapshot ${events.filter((x) => x.type === "snapshot").length}`);
    } catch {
      // ignore malformed payloads
    }
  });
  await page.send("Runtime.addBinding", { name: "__waaRecord" });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
  await page.goto(url);
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  browser.cdp.on("Target.targetDestroyed", (p) => {
    if (p.targetId === page.targetId) finish();
  });
  browser.chrome.process.once("exit", () => finish());
  await browser.cdp.send("Target.setDiscoverTargets", { discover: true });
  const done = ended.then(async () => {
    await browser.close().catch(() => {});
    server?.close();
    return eventsToScenario(events, viewport);
  });
  return { done, stop: () => finish(), page };
}
