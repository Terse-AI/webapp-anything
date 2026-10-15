/* webapp-anything: browser stand-ins for the Electron renderer APIs. MIT License. */
(() => {
  if (window.__waaElectronShim) return;
  window.__waaElectronShim = true;

  const unavailable = (what) => new Error(`${what} is not available in the web version of this app.`);
  const listeners = new Map();
  const channel = (name) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    return set;
  };

  const ipcRenderer = {
    invoke(name) {
      return Promise.reject(unavailable(`IPC call "${name}"`));
    },
    send(name) {
      console.warn(`[webapp-anything] ipcRenderer.send("${name}") ignored on the web.`);
    },
    sendSync(name) {
      console.warn(`[webapp-anything] ipcRenderer.sendSync("${name}") ignored on the web.`);
      return undefined;
    },
    postMessage(name) {
      console.warn(`[webapp-anything] ipcRenderer.postMessage("${name}") ignored on the web.`);
    },
    on(name, fn) {
      channel(name).add(fn);
      return ipcRenderer;
    },
    once(name, fn) {
      const wrapper = (...args) => {
        channel(name).delete(wrapper);
        fn(...args);
      };
      channel(name).add(wrapper);
      return ipcRenderer;
    },
    off(name, fn) {
      channel(name).delete(fn);
      return ipcRenderer;
    },
    removeListener(name, fn) {
      return ipcRenderer.off(name, fn);
    },
    removeAllListeners(name) {
      if (name) listeners.delete(name);
      else listeners.clear();
      return ipcRenderer;
    },
  };

  const electron = {
    ipcRenderer,
    contextBridge: {
      exposeInMainWorld(key, api) {
        window[key] = api;
      },
      exposeInIsolatedWorld(_id, key, api) {
        window[key] = api;
      },
    },
    shell: {
      openExternal(url) {
        window.open(url, "_blank", "noopener");
        return Promise.resolve();
      },
      openPath() {
        return Promise.resolve("Not available on the web");
      },
    },
    clipboard: {
      writeText(text) {
        navigator.clipboard?.writeText(String(text)).catch(() => {});
      },
      readText() {
        return "";
      },
    },
    webFrame: {
      setZoomFactor() {},
      getZoomFactor() {
        return 1;
      },
      setVisualZoomLevelLimits() {},
    },
    webUtils: {
      getPathForFile(file) {
        return file?.name ?? "";
      },
    },
  };

  const modules = { electron };
  if (typeof window.require !== "function") {
    window.require = (name) => {
      if (Object.hasOwn(modules, name)) return modules[name];
      throw unavailable(`Module "${name}"`);
    };
  }
  if (!window.process) {
    window.process = {
      platform: "browser",
      type: "renderer",
      env: {},
      versions: {},
      argv: [],
      cwd: () => "/",
      nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    };
  }
})();
