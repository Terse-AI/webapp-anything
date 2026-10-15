/* webapp-anything player shell — shared by every generated bundle. MIT License. */
(() => {
  const $ = (id) => document.getElementById(id);
  const configEl = $("waa-config");
  const config = configEl ? JSON.parse(configEl.textContent || "{}") : {};
  const overlay = $("waa-overlay");
  const statusEl = $("waa-status");
  const bar = $("waa-progress");
  const errorEl = $("waa-error");
  const hintEl = $("waa-hint");
  const playBtn = $("waa-play");
  const stage = $("waa-stage");
  const ISOLATION_KEY = "waa-isolation-attempt";
  let isReady = false;

  function setState(state) {
    overlay.dataset.state = state;
    overlay.hidden = state === "ready";
  }

  function status(text) {
    if (isReady) return;
    statusEl.textContent = text;
    setState("loading");
  }

  function progress(fraction) {
    if (fraction == null || !Number.isFinite(fraction)) bar.removeAttribute("value");
    else bar.value = Math.max(0, Math.min(1, fraction));
  }

  function ready() {
    if (isReady) return;
    isReady = true;
    setState("ready");
    document.body.classList.add("waa-running");
    try {
      sessionStorage.removeItem(ISOLATION_KEY);
    } catch {}
    if (config.offline !== false) registerWorker().catch(() => {});
  }

  function fail(err, hint) {
    const message = err instanceof Error ? err.message : String(err || "Unknown error");
    console.error("[webapp-anything]", err);
    errorEl.textContent = message;
    hintEl.textContent = hint || "";
    hintEl.hidden = !hint;
    isReady = false;
    setState("error");
  }

  function registerWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return Promise.reject(new Error("no sw"));
    return navigator.serviceWorker.register("sw.js");
  }

  /**
   * SharedArrayBuffer needs cross-origin isolation. Prefer real COOP/COEP headers from the
   * host; otherwise install the bundle's service worker, which adds them, and reload once.
   */
  async function ensureIsolation() {
    if (window.crossOriginIsolated) return true;
    let attempted = false;
    try {
      attempted = sessionStorage.getItem(ISOLATION_KEY) === "1";
    } catch {}
    if (attempted || !("serviceWorker" in navigator) || !window.isSecureContext) {
      fail(
        "This app needs cross-origin isolation, which this page does not have.",
        window.isSecureContext
          ? "Serve it with the headers Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp (waa serve and waa preview do this)."
          : "Open it over HTTPS (or on localhost).",
      );
      return false;
    }
    status("Preparing secure context…");
    try {
      sessionStorage.setItem(ISOLATION_KEY, "1");
    } catch {}
    await registerWorker();
    await navigator.serviceWorker.ready;
    location.reload();
    return new Promise(() => {});
  }

  function gate() {
    if (config.autostart) return Promise.resolve();
    setState("gate");
    playBtn.focus({ preventScroll: true });
    return new Promise((resolve) => {
      playBtn.addEventListener(
        "click",
        () => {
          status("Starting…");
          resolve();
        },
        { once: true },
      );
    });
  }

  async function start() {
    if (config.isolation && !(await ensureIsolation())) throw new Error("isolation unavailable");
    await gate();
    status("Loading…");
    progress(null);
  }

  function loadScript(src, options = {}) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      if (options.module) s.type = "module";
      if (options.crossOrigin) s.crossOrigin = options.crossOrigin;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function fetchWithProgress(url, label) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks = [];
    let have = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      have += value.byteLength;
      progress(have / total);
      if (label) status(`${label} ${Math.round((have / total) * 100)}%`);
    }
    const out = new Uint8Array(have);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    progress(null);
    return out;
  }

  function toggleFullscreen() {
    const el = document.fullscreenElement;
    if (el) document.exitFullscreen().catch(() => {});
    else
      (stage.requestFullscreen ? stage.requestFullscreen() : Promise.reject()).catch(() => {
        document.body.classList.toggle("waa-soft-fullscreen");
      });
  }

  async function showInfo() {
    const dialog = $("waa-info");
    const body = $("waa-info-body");
    if (!body.dataset.loaded) {
      try {
        const m = await (await fetch("waa.json", { cache: "no-cache" })).json();
        const rows = [
          [
            "Original",
            `${m.source.name}${m.source.entry && m.source.entry !== m.source.name ? ` → ${m.source.entry}` : ""}`,
          ],
          ["Runs on", `${m.backend.id}${m.backend.stability === "experimental" ? " (experimental)" : ""}`],
          ["Built", new Date(m.createdAt).toLocaleString()],
        ];
        const table = document.createElement("dl");
        for (const [k, v] of rows) {
          const dt = document.createElement("dt");
          dt.textContent = k;
          const dd = document.createElement("dd");
          dd.textContent = v;
          table.append(dt, dd);
        }
        const list = document.createElement("ul");
        for (const r of m.runtimes) {
          const li = document.createElement("li");
          const a = document.createElement("a");
          a.href = r.homepage;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = `${r.name} ${r.version}`;
          li.append(a, ` — ${r.license}`);
          if (r.source) {
            const src = document.createElement("a");
            src.href = r.source;
            src.target = "_blank";
            src.rel = "noopener";
            src.textContent = "source";
            li.append(" (", src, ")");
          }
          list.append(li);
        }
        const h = document.createElement("h3");
        h.textContent = "Open-source runtimes";
        body.replaceChildren(table, h, list);
        for (const n of m.notices || []) {
          const p = document.createElement("p");
          p.className = "waa-notice";
          p.textContent = n;
          body.append(p);
        }
        body.dataset.loaded = "1";
      } catch {
        body.textContent = "Bundle details are unavailable.";
      }
    }
    if (dialog.showModal) dialog.showModal();
  }

  $("waa-fullscreen")?.addEventListener("click", toggleFullscreen);
  $("waa-info-btn")?.addEventListener("click", showInfo);
  $("waa-info-close")?.addEventListener("click", () => $("waa-info").close());
  $("waa-retry")?.addEventListener("click", () => location.reload());

  // Runtimes reject promises for harmless reasons (keyboard lock, audio unlock…). Boot code
  // reports real failures through WAA.fail, so stray errors are only logged.
  window.addEventListener("error", (e) => console.warn("[webapp-anything]", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => console.warn("[webapp-anything]", e.reason));

  window.WAA = { config, stage, status, progress, ready, fail, start, loadScript, fetchWithProgress };
})();
