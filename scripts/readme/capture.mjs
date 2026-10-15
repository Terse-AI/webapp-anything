#!/usr/bin/env node
// Captures the README screenshots by running each sample app in headless Chrome.
//
//   1. Build and publish the samples to a local server:
//        node dist/cli.js serve --port 8797 --token dev-token-0123456789abcdef &
//        for n in dos flash floppy win32 java linux; do ...; done   (see scripts/readme/README.md)
//   2. node scripts/readme/capture.mjs --server http://localhost:8797 --out .github/assets/screens
//
// Uses the Chrome DevTools Protocol directly (Node's built-in WebSocket); no extra dependencies.
// Chrome runs with SwiftShader (software GL) unless --gpu is given (needed for the Flash shot).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    server: { type: "string", default: "http://localhost:8797" },
    out: { type: "string", default: ".github/assets/screens" },
    only: { type: "string" },
    chrome: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    scale: { type: "string", default: "2" },
    // Ruffle warns about missing hardware acceleration under SwiftShader; use the GPU for it.
    gpu: { type: "boolean", default: false },
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9333;

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method) for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  /** Record frames at display rate for `ms` and save every `step`-th one as name-1.png, name-2.png… */
  async burst(file, ms, step, max) {
    const frames = [];
    this.on("Page.screencastFrame", (p) => {
      frames.push(p.data);
      this.send("Page.screencastFrameAck", { sessionId: p.sessionId });
    });
    await this.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await sleep(ms);
    await this.send("Page.stopScreencast");
    const picked = frames.filter((_, i) => i % step === 0).slice(0, max);
    for (const [i, data] of picked.entries()) {
      writeFileSync(file.replace(/\.png$/, `-${i + 1}.png`), Buffer.from(data, "base64"));
    }
    console.log(`  saved ${picked.length} burst frames (${frames.length} recorded)`);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expression, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.eval(expression).catch(() => false)) return;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${label}`);
  }
  async click(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(120);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sleep(120);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
  async typeText(text) {
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleep(40);
    }
  }
  async enter() {
    const p = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...p });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
  }
  async shot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`  saved ${file}`);
  }
}

const READY = `document.getElementById("waa-overlay")?.dataset.state === "ready"`;

async function start(cdp) {
  await cdp.waitFor(`!!document.getElementById("waa-play")`, 15000, "player");
  const r = await cdp.eval(
    `(() => { const b = document.getElementById("waa-play").getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`,
  );
  await cdp.click(r[0], r[1]);
  if (process.env.WAA_CAPTURE_DEBUG) {
    await sleep(6000);
    console.log(
      "  state",
      await cdp.eval(`JSON.stringify({ isolated: crossOriginIsolated, state: document.getElementById("waa-overlay").dataset.state,
        status: document.getElementById("waa-status").textContent, error: document.getElementById("waa-error").textContent })`),
    );
  }
}

/** Per-app recipes: what to wait for and how to make the screenshot interesting. */
const APPS = {
  dos: async (cdp, file) => {
    await start(cdp);
    await cdp.waitFor(READY, 60000, "DOSBox");
    await sleep(4000);
    await cdp.shot(file);
  },
  flash: async (cdp, file) => {
    await start(cdp);
    await cdp.waitFor(READY, 60000, "Ruffle");
    await sleep(2500);
    await cdp.shot(file);
    // A short burst so the showcase can show the movie moving.
    await cdp.burst(file, 1600, 2, 16);
  },
  floppy: async (cdp, file) => {
    await start(cdp);
    await cdp.waitFor(READY, 60000, "v86");
    await sleep(5000);
    await cdp.shot(file);
  },
  java: async (cdp, file) => {
    await start(cdp);
    await cdp.waitFor(READY, 60000, "CheerpJ");
    await cdp.waitFor(
      `document.querySelectorAll("#java canvas, #java .cheerpjWindow, #java *").length > 5`,
      120000,
      "Swing window",
    );
    await sleep(30000);
    for (let i = 0; i < 3; i++) {
      await cdp.click(400, 426);
      await sleep(1500);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 760, y: 560 });
    await sleep(1500);
    await cdp.shot(file);
  },
  linux: async (cdp, file) => {
    await start(cdp);
    await cdp.waitFor(
      `(document.querySelector(".xterm-rows")?.textContent || "").includes("name?")`,
      180000,
      "Linux prompt",
    );
    await cdp.eval(`document.querySelector(".xterm-helper-textarea")?.focus()`);
    await cdp.typeText("Ada Lovelace");
    await cdp.enter();
    await cdp.waitFor(
      `(document.querySelector(".xterm-rows")?.textContent || "").includes("Greetings")`,
      30000,
      "Linux output",
    );
    await sleep(1500);
    await cdp.shot(file);
  },
  win32: async (cdp, file) => {
    await start(cdp);
    await cdp.waitFor(
      `(document.getElementById("output")?.value || "").includes("Showing Window")`,
      300000,
      "Wine window",
    );
    await sleep(12000);
    const [x, y] = await cdp.eval(
      `(() => { const c = document.getElementById("canvas").getBoundingClientRect(); const s = c.width / 800; return [c.left + 318 * s, c.top + 254 * s]; })()`,
    );
    for (let i = 0; i < 3; i++) {
      await cdp.click(x, y);
      await sleep(2500);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 760, y: 580 });
    await sleep(3000);
    if (process.env.WAA_CAPTURE_DEBUG) {
      console.log(
        "  layout",
        await cdp.eval(`JSON.stringify({ scrollY, root: document.scrollingElement.scrollTop, body: document.body.className,
          bar: document.querySelector(".waa-bar").getBoundingClientRect().top, stage: document.getElementById("waa-stage").getBoundingClientRect().top,
          canvas: document.getElementById("canvas").getBoundingClientRect().top, canvasStyle: document.getElementById("canvas").getAttribute("style"),
          fullscreen: !!document.fullscreenElement })`),
      );
    }
    await cdp.shot(file);
  },
};

async function main() {
  mkdirSync(values.out, { recursive: true });
  const profile = mkdtempSync(path.join(os.tmpdir(), "waa-chrome-"));
  const chrome = spawn(
    values.chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(values.gpu ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
      "--lang=en-US",
      "--autoplay-policy=no-user-gesture-required",
      "--window-size=800,600",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    let version;
    for (let i = 0; i < 50 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(
        (r) => r.json(),
        () => undefined,
      );
      if (!version) await sleep(200);
    }
    if (!version) throw new Error("Chrome did not start");
    const names = values.only ? values.only.split(",") : Object.keys(APPS);
    for (const name of names) {
      console.log(`capturing ${name}…`);
      const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then(
        (r) => r.json(),
      );
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      const cdp = new Cdp(ws);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 600,
        deviceScaleFactor: Number(values.scale),
        mobile: false,
      });
      await cdp.send("Page.navigate", { url: `${values.server}/a/hello-${name}/` });
      await cdp.waitFor(`document.readyState === "complete"`, 30000, "page load");
      try {
        await APPS[name](cdp, path.join(values.out, `${name}.png`));
      } catch (err) {
        console.error(`  ${name}: ${err.message}`);
        await cdp.shot(path.join(values.out, `${name}-failed.png`)).catch(() => {});
      }
      ws.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {});
    }
  } finally {
    chrome.kill();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
