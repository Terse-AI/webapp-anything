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

  // The play button is on screen as soon as the page renders, before the boot module runs,
  // so remember an early click instead of attaching the listener late.
  let played = false;
  let onPlay = null;
  playBtn.addEventListener("click", () => {
    if (played) return;
    played = true;
    status("Starting…");
    onPlay?.();
  });

  function gate() {
    if (config.autostart || played) return Promise.resolve();
    setState("gate");
    playBtn.focus({ preventScroll: true });
    return new Promise((resolve) => {
      onPlay = resolve;
    });
  }

  async function start() {
    if (config.isolation && !(await ensureIsolation())) throw new Error("isolation unavailable");
    await gate();
    if (saveProvider) {
      status("Checking saved games…");
      await pullSave(false).catch((err) => console.warn("[webapp-anything] save sync failed", err));
    }
    status("Loading…");
    progress(null);
  }

  // ---- Saved games -----------------------------------------------------------------------
  // Backends register a provider that can capture and restore the program's state. The
  // player stores one local slot per app (IndexedDB), exports/imports .waasave files, and,
  // when the host offers it (waa-sync.json), syncs the slot between devices with a code.

  const SAVE_KEY = location.pathname.replace(/[^/]*$/, "") || "/";
  const SYNC_CODE_KEY = `waa-sync-code:${SAVE_KEY}`;
  const SYNC_SEEN_KEY = `waa-sync-seen:${SAVE_KEY}`;
  const MAGIC = [0x57, 0x41, 0x41, 0x53];
  let saveProvider = null;
  let syncInfo;
  let pushTimer = null;

  const store = {
    get(key) {
      try {
        return localStorage.getItem(key) || "";
      } catch {
        return "";
      }
    },
    set(key, value) {
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch {}
    },
  };

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("waa-saves", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("saves");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbRun(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("saves", mode);
      const req = fn(tx.objectStore("saves"));
      tx.oncomplete = () => {
        db.close();
        resolve(req ? req.result : undefined);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  /** The app's local save slot. `bytes` is whatever the backend's runtime produced. */
  const local = {
    async read() {
      try {
        return (await dbRun("readonly", (s) => s.get(SAVE_KEY))) || null;
      } catch {
        return null;
      }
    },
    async write(bytes, options = {}) {
      const record = { bytes: new Uint8Array(bytes), updatedAt: Date.now() };
      await dbRun("readwrite", (s) => s.put(record, SAVE_KEY));
      if (!options.fromSync) schedulePush();
      return record;
    },
    async clear() {
      await dbRun("readwrite", (s) => s.delete(SAVE_KEY));
    },
  };

  function packSave(payload) {
    const header = new TextEncoder().encode(
      JSON.stringify({
        format: "waa-save",
        version: 1,
        backend: config.backend,
        title: config.title,
        app: SAVE_KEY,
        createdAt: new Date().toISOString(),
      }),
    );
    const out = new Uint8Array(8 + header.length + payload.length);
    out.set(MAGIC, 0);
    new DataView(out.buffer).setUint32(4, header.length, true);
    out.set(header, 8);
    out.set(payload, 8 + header.length);
    return out;
  }

  function unpackSave(bytes) {
    if (!MAGIC.every((b, i) => bytes[i] === b)) throw new Error("This is not a webapp-anything save file.");
    const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
    if (header.format !== "waa-save") throw new Error("This is not a webapp-anything save file.");
    if (header.backend !== config.backend)
      throw new Error(`This save belongs to a different kind of app (${header.backend}).`);
    return { header, payload: bytes.slice(8 + len) };
  }

  async function syncConfig() {
    if (syncInfo !== undefined) return syncInfo;
    try {
      const res = await fetch("waa-sync.json", { cache: "no-cache" });
      syncInfo = res.ok ? await res.json() : null;
    } catch {
      syncInfo = null;
    }
    return syncInfo;
  }

  function schedulePush() {
    if (!store.get(SYNC_CODE_KEY)) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(
      () => pushSave().catch((err) => console.warn("[webapp-anything] save upload failed", err)),
      3000,
    );
  }

  /** Capture the current state and upload it. Returns false when there is nothing to save. */
  async function pushSave() {
    const info = await syncConfig();
    const code = store.get(SYNC_CODE_KEY);
    if (!info || !code || !saveProvider) return false;
    const payload = await saveProvider.capture();
    if (!payload) return false;
    const res = await fetch(`${info.endpoint}/${encodeURIComponent(code)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: packSave(payload),
    });
    if (!res.ok) throw new Error(`Could not upload the save (HTTP ${res.status}).`);
    const body = await res.json();
    store.set(SYNC_SEEN_KEY, String(body.updatedAt));
    renderSaves();
    return true;
  }

  /**
   * Download the synced save if another device uploaded a newer one (or always when `force`).
   * Returns true when local state changed.
   */
  async function pullSave(force) {
    const info = await syncConfig();
    const code = store.get(SYNC_CODE_KEY);
    if (!info || !code || !saveProvider) return false;
    const res = await fetch(`${info.endpoint}/${encodeURIComponent(code)}`, { cache: "no-cache" });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Could not download the save (HTTP ${res.status}).`);
    const updatedAt = Number(res.headers.get("x-waa-updated-at")) || 0;
    if (!force && updatedAt <= Number(store.get(SYNC_SEEN_KEY) || 0)) return false;
    const { payload } = unpackSave(new Uint8Array(await res.arrayBuffer()));
    await saveProvider.restore(payload);
    store.set(SYNC_SEEN_KEY, String(updatedAt));
    return true;
  }

  function savesStatus(text) {
    const el = $("waa-saves-status");
    if (el) el.textContent = text;
  }

  function renderSaves() {
    const code = store.get(SYNC_CODE_KEY);
    const codeEl = $("waa-sync-code");
    if (codeEl) codeEl.textContent = code || "not set up";
    const seen = Number(store.get(SYNC_SEEN_KEY) || 0);
    const syncNote = $("waa-sync-note");
    if (syncNote) syncNote.textContent = code && seen ? `Last synced ${new Date(seen).toLocaleString()}` : "";
    for (const id of ["waa-sync-copy", "waa-sync-off"]) {
      const el = $(id);
      if (el) el.hidden = !code;
    }
  }

  async function openSaves() {
    renderSaves();
    const info = await syncConfig();
    const section = $("waa-sync");
    if (section) section.hidden = !info;
    const saved = saveProvider ? await local.read() : null;
    savesStatus(
      saved
        ? `Saved on this device ${new Date(saved.updatedAt).toLocaleString()}.`
        : "Your progress is saved in this browser.",
    );
    $("waa-saves").showModal?.();
  }

  async function guarded(fn) {
    try {
      await fn();
    } catch (err) {
      savesStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function wireSaves() {
    $("waa-saves-btn")?.addEventListener("click", openSaves);
    $("waa-saves-close")?.addEventListener("click", () => $("waa-saves").close());
    $("waa-save-now")?.addEventListener("click", () =>
      guarded(async () => {
        const payload = await saveProvider.capture();
        if (!payload) return savesStatus("Nothing to save yet.");
        const pushed = await pushSave().catch(() => false);
        savesStatus(pushed ? "Saved and synced." : "Saved on this device.");
      }),
    );
    $("waa-save-download")?.addEventListener("click", () =>
      guarded(async () => {
        const payload = await saveProvider.capture();
        if (!payload) return savesStatus("Nothing to save yet.");
        const url = URL.createObjectURL(new Blob([packSave(payload)], { type: "application/octet-stream" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `${(config.title || "app").replace(/[^\w.-]+/g, "-")}.waasave`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        savesStatus("Save file downloaded. Load it on another device with “Load save file”.");
      }),
    );
    $("waa-save-file")?.addEventListener("change", (e) =>
      guarded(async () => {
        const file = e.target.files?.[0];
        if (!file) return;
        const { payload } = unpackSave(new Uint8Array(await file.arrayBuffer()));
        await saveProvider.restore(payload);
        schedulePush();
        savesStatus("Save loaded. Restarting…");
        setTimeout(() => location.reload(), 600);
      }),
    );
    $("waa-save-reset")?.addEventListener("click", () =>
      guarded(async () => {
        if (!confirm("Delete the saved progress on this device and start over?")) return;
        await saveProvider.clear();
        location.reload();
      }),
    );
    $("waa-sync-new")?.addEventListener("click", () =>
      guarded(async () => {
        const info = await syncConfig();
        const res = await fetch(info.endpoint, { method: "POST" });
        if (!res.ok) throw new Error(`Could not create a sync code (HTTP ${res.status}).`);
        const { code } = await res.json();
        store.set(SYNC_CODE_KEY, code);
        store.set(SYNC_SEEN_KEY, "");
        const pushed = await pushSave();
        renderSaves();
        savesStatus(
          pushed
            ? "Sync is on. Enter this code on your other device."
            : "Sync is on. Your progress uploads as you play.",
        );
      }),
    );
    $("waa-sync-connect")?.addEventListener("click", () =>
      guarded(async () => {
        const code = ($("waa-sync-input").value || "").trim().toUpperCase();
        if (!/^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/.test(code))
          throw new Error("That does not look like a sync code.");
        store.set(SYNC_CODE_KEY, code);
        store.set(SYNC_SEEN_KEY, "");
        const changed = await pullSave(true);
        renderSaves();
        if (changed && isReady) {
          savesStatus("Loaded the synced save. Restarting…");
          setTimeout(() => location.reload(), 600);
        } else
          savesStatus(
            changed ? "Loaded the synced save." : "Connected. Nothing has been uploaded with this code yet.",
          );
      }),
    );
    $("waa-sync-copy")?.addEventListener("click", () =>
      navigator.clipboard?.writeText(store.get(SYNC_CODE_KEY)).catch(() => {}),
    );
    $("waa-sync-off")?.addEventListener("click", () => {
      store.set(SYNC_CODE_KEY, "");
      store.set(SYNC_SEEN_KEY, "");
      renderSaves();
      savesStatus("Sync is off on this device.");
    });
    // Leaving the tab is the moment progress is most likely to be lost.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && saveProvider && isReady) {
        Promise.resolve(saveProvider.flush?.())
          .then(() => pushSave())
          .catch(() => {});
      }
    });
  }

  const saves = {
    local,
    /** provider: { capture(): Promise<Uint8Array|null>, restore(bytes), clear(), flush?() } */
    register(provider) {
      saveProvider = provider;
      const btn = $("waa-saves-btn");
      if (btn) btn.hidden = false;
    },
    exportFile: async () => {
      const payload = await saveProvider.capture();
      return payload ? packSave(payload) : null;
    },
    importFile: async (bytes) => {
      const { payload } = unpackSave(bytes);
      await saveProvider.restore(payload);
    },
    push: () => pushSave(),
    pull: (force) => pullSave(force),
    connect: (code) => {
      store.set(SYNC_CODE_KEY, code);
      store.set(SYNC_SEEN_KEY, "");
    },
  };

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

  // The player is a fixed, full-window layout; runtimes that focus their canvas must not scroll it.
  window.addEventListener("scroll", () => {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  });

  $("waa-fullscreen")?.addEventListener("click", toggleFullscreen);
  $("waa-info-btn")?.addEventListener("click", showInfo);
  $("waa-info-close")?.addEventListener("click", () => $("waa-info").close());
  $("waa-retry")?.addEventListener("click", () => location.reload());
  wireSaves();

  // Runtimes reject promises for harmless reasons (keyboard lock, audio unlock…). Boot code
  // reports real failures through WAA.fail, so stray errors are only logged.
  window.addEventListener("error", (e) => console.warn("[webapp-anything]", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => console.warn("[webapp-anything]", e.reason));

  window.WAA = { config, stage, status, progress, ready, fail, start, loadScript, fetchWithProgress, saves };
})();
