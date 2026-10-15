/* webapp-anything server UI. No framework, no build step. MIT License. */
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "waa-token";
  const state = { info: null, upload: null, plan: null, admin: false };

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {}
  }
  function authHeaders() {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  async function api(path, options = {}) {
    const res = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Request failed (HTTP ${res.status})`);
      err.hint = body.hint;
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
  }

  function show(step) {
    for (const id of ["step-upload", "step-plan", "step-done"]) $(id).hidden = id !== step;
  }

  function list(el, items) {
    el.replaceChildren();
    if (!items.length) {
      el.hidden = true;
      return;
    }
    const ul = document.createElement("ul");
    for (const t of items) {
      const li = document.createElement("li");
      li.textContent = t;
      ul.append(li);
    }
    el.append(ul);
    el.hidden = false;
  }

  function uploadFile(file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/uploads?filename=${encodeURIComponent(file.name)}`);
      const t = getToken();
      if (t) xhr.setRequestHeader("Authorization", `Bearer ${t}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          $("upload-bar").value = e.loaded / e.total;
          $("upload-label").textContent = `Uploading ${formatBytes(e.loaded)} of ${formatBytes(e.total)}…`;
        }
      };
      xhr.upload.onload = () => {
        $("upload-bar").removeAttribute("value");
        $("upload-label").textContent = "Scanning…";
      };
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else {
          const err = new Error(body.error || `Upload failed (HTTP ${xhr.status})`);
          err.hint = body.hint;
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error("Network error while uploading."));
      xhr.send(file);
    });
  }

  async function handleFile(file) {
    if (!file) return;
    if (state.info && file.size > state.info.maxUploadBytes) {
      alert(
        `That file is ${formatBytes(file.size)}; this server accepts up to ${formatBytes(state.info.maxUploadBytes)}.`,
      );
      return;
    }
    $("upload-progress").hidden = false;
    $("upload-bar").value = 0;
    $("upload-label").textContent = "Uploading…";
    try {
      const res = await uploadFile(file);
      state.upload = res.upload;
      state.plan = res.plan;
      renderPlan(res);
      show("step-plan");
    } catch (err) {
      if (err.status === 401) {
        $("upload-label").textContent = "This server needs a publish token.";
        openTokenDialog();
      } else {
        $("upload-label").textContent = err.message + (err.hint ? ` ${err.hint}` : "");
      }
      return;
    } finally {
      $("file").value = "";
    }
    $("upload-progress").hidden = true;
  }

  function renderPlan(res) {
    const { scan, plan, suggested } = res;
    $("found-file").textContent = `${scan.input.name} (${formatBytes(scan.input.size)})`;
    $("found-summary").textContent = scan.summary;
    const select = $("backend");
    select.replaceChildren();
    const names = Object.fromEntries((state.info?.backends || []).map((b) => [b.id, b.title]));
    for (const c of plan.candidates.filter((c) => c.score > 0 && c.backend !== "stream")) {
      const opt = document.createElement("option");
      opt.value = c.backend;
      opt.textContent = `${names[c.backend] || c.backend}${c.stability === "experimental" ? " — experimental" : ""}`;
      if (plan.chosen && plan.chosen.backend === c.backend) opt.selected = true;
      select.append(opt);
    }
    const supported = select.options.length > 0;
    $("found-unsupported").hidden = supported;
    $("found-unsupported").textContent = supported
      ? ""
      : plan.unsupported || "None of the browser runtimes can run this file.";
    $("publish").disabled = !supported;
    const warnings = [...new Set([...(scan.warnings || []), ...(plan.chosen?.warnings || [])])];
    list($("found-warnings"), warnings);
    $("title").value = suggested.title;
    $("slug").value = suggested.slug;
    $("publish-error").hidden = true;
  }

  async function publish(e) {
    e.preventDefault();
    const btn = $("publish");
    btn.disabled = true;
    btn.textContent = "Building…";
    $("publish-error").hidden = true;
    try {
      const res = await api("/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload: state.upload,
          backend: $("backend").value,
          title: $("title").value,
          slug: $("slug").value,
          autostart: $("autostart").checked,
        }),
      });
      $("done-link").href = res.url;
      $("done-link").textContent = res.url;
      $("done-open").href = res.url;
      $("done-key").textContent = state.admin
        ? ""
        : `Delete key: ${res.deleteKey} — keep it to replace or delete this app later.`;
      list($("done-warnings"), res.warnings || []);
      show("step-done");
      refreshApps();
    } catch (err) {
      $("publish-error").textContent = err.message + (err.hint ? ` ${err.hint}` : "");
      $("publish-error").hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Publish";
    }
  }

  async function refreshApps() {
    if (!state.admin) {
      $("apps-section").hidden = true;
      return;
    }
    try {
      const res = await api("/api/apps");
      const ul = $("apps");
      ul.replaceChildren();
      for (const app of res.apps) {
        const li = document.createElement("li");
        const meta = document.createElement("div");
        meta.className = "meta";
        const a = document.createElement("a");
        a.href = app.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = app.title;
        const sub = document.createElement("div");
        sub.className = "muted small";
        sub.textContent = `${app.backend} · ${app.source.name} · ${formatBytes(app.size)} · ${new Date(app.updatedAt).toLocaleString()}`;
        meta.append(a, sub);
        const del = document.createElement("button");
        del.className = "btn danger";
        del.type = "button";
        del.textContent = "Delete";
        del.addEventListener("click", async () => {
          if (!confirm(`Delete “${app.title}”? Its link will stop working.`)) return;
          await api(`/api/apps/${encodeURIComponent(app.slug)}`, { method: "DELETE" }).catch((err) =>
            alert(err.message),
          );
          refreshApps();
        });
        li.append(meta, del);
        ul.append(li);
      }
      $("apps-stats").textContent =
        `${res.count} app${res.count === 1 ? "" : "s"} · ${formatBytes(res.bytes)}`;
      $("apps-section").hidden = res.apps.length === 0;
    } catch {
      $("apps-section").hidden = true;
    }
  }

  async function refreshSession() {
    const s = await api("/api/session").catch(() => ({ admin: false }));
    state.admin = !!s.admin;
    $("token-btn").textContent = state.admin ? "Signed in" : "Publish token";
    refreshApps();
  }

  function openTokenDialog() {
    $("token").value = getToken();
    $("token-dialog").showModal();
  }

  async function init() {
    try {
      state.info = await api("/api/info");
      $("version").textContent = `v${state.info.version}`;
      const chips = $("backends");
      for (const b of state.info.backends.filter((b) => b.id !== "stream")) {
        const li = document.createElement("li");
        li.textContent = b.title;
        li.title = b.runs;
        chips.append(li);
      }
    } catch {}
    $("slug-prefix").textContent = `${location.origin}/a/`;
    const drop = $("drop");
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      handleFile(e.dataTransfer.files[0]);
    });
    $("file").addEventListener("change", (e) => handleFile(e.target.files[0]));
    $("publish-form").addEventListener("submit", publish);
    $("restart").addEventListener("click", () => show("step-upload"));
    $("done-again").addEventListener("click", () => show("step-upload"));
    $("done-copy").addEventListener("click", () =>
      navigator.clipboard.writeText($("done-link").href).catch(() => {}),
    );
    $("token-btn").addEventListener("click", openTokenDialog);
    $("token-cancel").addEventListener("click", () => $("token-dialog").close());
    $("token-clear").addEventListener("click", () => {
      setToken("");
      $("token-dialog").close();
      refreshSession();
    });
    $("token-form").addEventListener("submit", () => {
      setToken($("token").value.trim());
      refreshSession();
    });
    $("title").addEventListener("input", () => {
      if ($("slug").dataset.touched) return;
      $("slug").value =
        $("title")
          .value.toLowerCase()
          .normalize("NFKD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 63) || "app";
    });
    $("slug").addEventListener("input", () => {
      $("slug").dataset.touched = "1";
    });
    refreshSession();
  }

  init();
})();
