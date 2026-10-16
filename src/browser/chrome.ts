import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UserError } from "../util/errors.js";

/** Find a Chrome/Chromium binary: $WAA_CHROME or $CHROME_PATH, then the usual install locations. */
export function findChrome(): string | undefined {
  for (const env of [process.env.WAA_CHROME, process.env.CHROME_PATH]) {
    if (env && existsSync(env)) return env;
  }
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    for (const app of [
      "Google Chrome",
      "Google Chrome Canary",
      "Chromium",
      "Microsoft Edge",
      "Brave Browser",
    ]) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      candidates.push(path.join(os.homedir(), `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const root of roots as string[]) {
      candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(root, "Chromium", "Application", "chrome.exe"));
      candidates.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      for (const name of [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
      ]) {
        candidates.push(path.join(dir, name));
      }
    }
  }
  return candidates.find((c) => existsSync(c));
}

export interface ChromeOptions {
  headless?: boolean;
  /** Use the GPU (default: SwiftShader software rendering, which never touches the GPU). */
  gpu?: boolean;
  /** Extra command-line flags. */
  args?: string[];
  executable?: string;
  windowSize?: { width: number; height: number };
}

export interface ChromeProcess {
  /** Browser-level DevTools WebSocket URL. */
  wsEndpoint: string;
  process: ChildProcess;
  close(): Promise<void>;
}

/** Start Chrome with remote debugging on a free port and return its DevTools endpoint. */
export async function launchChrome(options: ChromeOptions = {}): Promise<ChromeProcess> {
  const executable = options.executable ?? findChrome();
  if (!executable) {
    throw new UserError(
      "Google Chrome or Chromium was not found.",
      "Install Chrome, or point WAA_CHROME at a Chrome/Chromium executable.",
    );
  }
  const profile = await mkdtemp(path.join(os.tmpdir(), "waa-chrome-"));
  const size = options.windowSize ?? { width: 1024, height: 768 };
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--lang=en-US",
    "--autoplay-policy=no-user-gesture-required",
    `--window-size=${size.width},${size.height}`,
    ...(options.headless === false ? [] : ["--headless=new"]),
    ...(options.gpu ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
    ...(options.args ?? []),
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("Chrome did not report a DevTools endpoint within 20s")),
      20_000,
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (code ${code})`));
    });
  });
  child.stderr?.resume();
  let closed = false;
  return {
    wsEndpoint,
    process: child,
    async close() {
      if (closed) return;
      closed = true;
      if (child.exitCode === null) {
        child.kill();
        await new Promise((r) => {
          const t = setTimeout(r, 3000);
          child.once("exit", () => {
            clearTimeout(t);
            r(undefined);
          });
        });
      }
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}
