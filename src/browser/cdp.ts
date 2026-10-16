import { type ChromeOptions, type ChromeProcess, launchChrome } from "./chrome.js";

type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

/** Minimal Chrome DevTools Protocol client over Node's built-in WebSocket (flat sessions). */
export class CdpConnection {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method)
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {}, msg.sessionId);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("DevTools connection closed"));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
    return new CdpConnection(ws);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
  }

  on(method: string, fn: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  close(): void {
    this.ws.close();
  }
}

export interface Viewport {
  width: number;
  height: number;
  /** Device pixel ratio for screenshots (default 1). */
  scale?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One browser tab driven over CDP. */
export class Page {
  private constructor(
    private readonly cdp: CdpConnection,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  static async open(cdp: CdpConnection, viewport: Viewport): Promise<Page> {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const page = new Page(cdp, sessionId, targetId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale ?? 1,
      mobile: false,
    });
    return page;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  on(method: string, fn: (params: Record<string, unknown>) => void): () => void {
    return this.cdp.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) fn(params);
    });
  }

  async goto(url: string, timeoutMs = 30_000): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.waitFor(`document.readyState === "complete"`, timeoutMs, "page load");
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value as T;
  }

  /** Poll a JS expression until it is truthy. */
  async waitFor(expression: string, timeoutMs: number, label = expression): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const ok = await this.evaluate<boolean>(`Boolean(${expression})`).catch(() => false);
      if (ok) return;
      if (Date.now() > end)
        throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
      await sleep(250);
    }
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async click(x: number, y: number, holdMs = 100): Promise<void> {
    await this.mouseMove(x, y);
    await sleep(60);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sleep(holdMs);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async typeText(text: string, delayMs = 40): Promise<void> {
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleep(delayMs);
    }
  }

  async pressKey(key: string): Promise<void> {
    const def = KEYS[key] ?? { key, code: key, keyCode: 0 };
    const base = {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
    };
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      ...(def.text ? { text: def.text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** PNG screenshot of the viewport (or a CSS-pixel region of it). */
  async screenshot(region?: { x: number; y: number; width: number; height: number }): Promise<Uint8Array> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      ...(region ? { clip: { ...region, scale: 1 } } : {}),
    });
    return new Uint8Array(Buffer.from(data, "base64"));
  }

  async close(): Promise<void> {
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  F1: { key: "F1", code: "F1", keyCode: 112 },
  F10: { key: "F10", code: "F10", keyCode: 121 },
};

/** A launched browser plus its DevTools connection. */
export class Browser {
  private constructor(
    readonly chrome: ChromeProcess,
    readonly cdp: CdpConnection,
  ) {}

  static async launch(options: ChromeOptions = {}): Promise<Browser> {
    const chrome = await launchChrome(options);
    try {
      const cdp = await CdpConnection.connect(chrome.wsEndpoint);
      return new Browser(chrome, cdp);
    } catch (err) {
      await chrome.close();
      throw err;
    }
  }

  newPage(viewport: Viewport): Promise<Page> {
    return Page.open(this.cdp, viewport);
  }

  async close(): Promise<void> {
    this.cdp.close();
    await this.chrome.close();
  }
}
