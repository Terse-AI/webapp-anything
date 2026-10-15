import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type Zippable, zipSync } from "fflate";
import { readBundleManifest } from "../build/bundle.js";
import { UserError } from "../util/errors.js";
import { type Logger, silentLogger } from "../util/log.js";
import { isValidSlug, safeRelativePath } from "../util/paths.js";

const exec = promisify(execFile);

export type PublishTarget = "server" | "github-pages" | "dir";

export interface PublishOptions {
  to: PublishTarget;
  server?: string;
  token?: string;
  slug?: string;
  repo?: string;
  remote?: string;
  branch?: string;
  path?: string;
  dest?: string;
  log?: Logger;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface PublishResult {
  url: string;
  notes: string[];
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const item of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (item.isFile()) out.push(rel);
  }
  return out.sort();
}

const STORED = /\.(zip|jsdos|jar|wasm|png|jpe?g|gif|webp|mp3|ogg|mp4|webm|woff2?|gz|br|iso|img|swf|tar)$/i;

/** Zip a bundle folder; already-compressed formats are stored as-is. */
export async function zipBundle(dir: string): Promise<Uint8Array> {
  const files: Zippable = {};
  for (const rel of await listFiles(dir)) {
    const data = new Uint8Array(await readFile(path.join(dir, ...rel.split("/"))));
    files[rel] = [data, { level: STORED.test(rel) ? 0 : 6 }];
  }
  return zipSync(files);
}

async function publishToServer(dir: string, o: PublishOptions, slug: string): Promise<PublishResult> {
  if (!o.server) throw new UserError("Pass --server <url> (or set WAA_SERVER).");
  const base = o.server.replace(/\/+$/, "");
  const body = await zipBundle(dir);
  const res = await (o.fetchImpl ?? fetch)(`${base}/api/apps/${encodeURIComponent(slug)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/zip",
      ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
    },
    body,
  });
  const text = await res.text();
  let json: { url?: string; error?: string; deleteKey?: string } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    const hint = res.status === 401 ? "Check --token / WAA_TOKEN." : undefined;
    throw new UserError(
      `Server refused the upload (HTTP ${res.status}): ${json.error ?? text.slice(0, 200)}`,
      hint,
    );
  }
  const notes = json.deleteKey
    ? [`Delete key (keep it to update or remove this app): ${json.deleteKey}`]
    : [];
  return { url: json.url ?? `${base}/a/${slug}/`, notes };
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new UserError(
      `git ${args[0]} failed: ${(e.stderr || e.message).trim().split("\n").slice(-3).join(" ")}`,
    );
  }
}

async function publishToGitHubPages(dir: string, o: PublishOptions, slug: string): Promise<PublishResult> {
  const repo = o.repo;
  if (!o.remote && !(repo && /^[\w.-]+\/[\w.-]+$/.test(repo))) {
    throw new UserError("Pass --repo owner/name (or --remote <git url>).");
  }
  const remote = o.remote ?? `git@github.com:${repo}.git`;
  const branch = o.branch ?? "gh-pages";
  const sub = o.path === undefined ? slug : o.path === "." || o.path === "/" ? "" : safeRelativePath(o.path);
  if (sub === null) throw new UserError(`Invalid --path: ${o.path}`);
  const notes: string[] = [];
  for (const rel of await listFiles(dir)) {
    const size = (await stat(path.join(dir, ...rel.split("/")))).size;
    if (size > 100 * 1024 * 1024) {
      throw new UserError(
        `${rel} is ${Math.round(size / 1048576)} MB; GitHub rejects files over 100 MB.`,
        "Use --to server, or another static host.",
      );
    }
    if (size > 50 * 1024 * 1024) notes.push(`${rel} is over 50 MB; GitHub will warn about it.`);
  }
  const work = await mkdtemp(path.join(os.tmpdir(), "waa-pages-"));
  try {
    const cloned = await exec("git", [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      branch,
      remote,
      work,
    ]).then(
      () => true,
      () => false,
    );
    if (!cloned) {
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });
      await git(["init", "--quiet"], work);
      await git(["checkout", "--quiet", "--orphan", branch], work);
      await git(["remote", "add", "origin", remote], work);
      notes.push(
        `Created the ${branch} branch. Enable GitHub Pages for it under Settings → Pages if you have not yet.`,
      );
    }
    const target = sub ? path.join(work, ...sub.split("/")) : work;
    if (sub) await rm(target, { recursive: true, force: true });
    else {
      for (const item of await readdir(work))
        if (item !== ".git") await rm(path.join(work, item), { recursive: true, force: true });
    }
    await cp(dir, target, { recursive: true });
    await writeFile(path.join(work, ".nojekyll"), "");
    await git(["add", "-A"], work);
    const status = await git(["status", "--porcelain"], work);
    if (status) {
      const message = `Publish ${slug} with webapp-anything`;
      // Commit as the user; fall back to a bot identity only when git has none configured.
      await git(["commit", "--quiet", "-m", message], work).catch(() =>
        git(
          [
            "-c",
            "user.name=webapp-anything",
            "-c",
            "user.email=webapp-anything@users.noreply.github.com",
            "commit",
            "--quiet",
            "-m",
            message,
          ],
          work,
        ),
      );
      await git(["push", "--quiet", "origin", `HEAD:${branch}`], work);
    } else {
      notes.push("Nothing changed since the last publish.");
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const manifest = await readBundleManifest(dir);
  if (manifest.requirements.crossOriginIsolation) {
    notes.push(
      "GitHub Pages cannot send COOP/COEP headers; the bundle's service worker adds them (one automatic reload on first visit).",
    );
  }
  let url = remote;
  if (repo) {
    const [owner, name] = repo.split("/") as [string, string];
    const host = `https://${owner.toLowerCase()}.github.io`;
    const root = name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? host : `${host}/${name}`;
    url = `${root}/${sub ? `${sub}/` : ""}`;
  }
  return { url, notes };
}

async function publishToDir(dir: string, o: PublishOptions): Promise<PublishResult> {
  if (!o.dest) throw new UserError("Pass --dest <folder>.");
  const dest = path.resolve(o.dest);
  const existing = await readdir(dest).catch(() => [] as string[]);
  if (existing.length && !existing.includes("waa.json")) {
    throw new UserError(`${dest} is not empty and is not a previous bundle.`);
  }
  await rm(dest, { recursive: true, force: true });
  await cp(dir, dest, { recursive: true });
  return {
    url: dest,
    notes: [
      "Upload this folder to any static host (Netlify, Cloudflare Pages and Vercel read the included header files).",
    ],
  };
}

export async function publishBundle(dir: string, o: PublishOptions): Promise<PublishResult> {
  const log = o.log ?? silentLogger;
  const manifest = await readBundleManifest(dir);
  if (manifest.type !== "static") {
    throw new UserError(
      "Container bundles cannot be published as static sites.",
      "Run `docker compose up --build` in the bundle folder on your server.",
    );
  }
  const slug = o.slug ?? manifest.app.slug;
  if (!isValidSlug(slug)) throw new UserError(`Invalid slug: ${slug}`);
  log.debug(`publishing ${dir} to ${o.to}`);
  switch (o.to) {
    case "server":
      return publishToServer(dir, o, slug);
    case "github-pages":
      return publishToGitHubPages(dir, o, slug);
    case "dir":
      return publishToDir(dir, o);
  }
}
