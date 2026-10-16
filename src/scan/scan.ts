import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAsar } from "../formats/asar.js";
import { readAndroidManifest } from "../formats/axml.js";
import { describeExecutable, type ExecutableInfo, parseExecutable } from "../formats/executables.js";
import { classFileJavaVersion, parseManifest } from "../formats/java.js";
import { isSwf, parseDiskImage, parseSwf } from "../formats/media.js";
import { bufferSource, formatBytes, Reader } from "../util/bytes.js";
import { UserError } from "../util/errors.js";
import { extname, posixBasename, posixDirname } from "../util/paths.js";
import { type FileTree, openTree, type TreeLimits } from "./tree.js";
import type { ElectronInfo, FoundProgram, InputKind, JavaInfo, ProgramKind, ScanReport } from "./types.js";

export interface ScanOptions {
  /** Force the program/file to run (path inside the input). */
  entry?: string;
  /** Name to report instead of the on-disk file name (used for uploads). */
  displayName?: string;
  /** Skip computing the input's sha256. */
  noHash?: boolean;
  limits?: Partial<TreeLimits>;
}

export interface ScanResult {
  report: ScanReport;
  tree: FileTree;
  inputPath: string;
}

const HEAD = 256 * 1024;
const EXE_HEAD = 8 * 1024 * 1024;

const NOT_MAIN =
  /^(setup|install|instal|installer|uninst|unins\d*|uninstall|config|configure|setsound|sndsetup|soundset|sound|setupsnd|patch|update|updater|vcredist.*|dxsetup|dxwebsetup|directx|crashreport\w*|crashpad\w*|helper|register|regist|readme|license|dos4gw|dos32a|pmodew|cwsdpmi|unzip|pkunzip|pkzip|lha|arj)$/i;

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

function stem(p: string): string {
  const base = posixBasename(p);
  const i = base.lastIndexOf(".");
  return (i > 0 ? base.slice(0, i) : base).toLowerCase();
}

function programKind(info: ExecutableInfo): ProgramKind | undefined {
  switch (info.format) {
    case "dos":
    case "le":
      return "dos";
    case "lx":
      return undefined;
    case "ne":
      return info.targetOs === "windows" || info.targetOs === "win386"
        ? "win16"
        : info.targetOs === "dos4"
          ? "dos"
          : undefined;
    case "pe":
      if (info.dotnet) return "dotnet";
      if (info.arch === "x86") return "win32";
      if (info.arch === "x86_64") return "win64";
      return "win-arm";
    case "elf":
      return "linux";
    case "macho":
      return "macos";
  }
}

const KIND_BASE: Record<ProgramKind, number> = {
  win32: 60,
  jar: 58,
  swf: 56,
  dos: 55,
  win16: 52,
  linux: 50,
  dotnet: 45,
  win64: 45,
  disk: 40,
  "win-arm": 25,
  batch: 30,
  macos: 10,
};

function scoreProgram(
  p: { path: string; size: number; kind: ProgramKind; info?: ExecutableInfo },
  inputName: string,
): number {
  let s = KIND_BASE[p.kind];
  const depth = p.path.split("/").length - 1;
  s -= depth * 4;
  const name = stem(p.path);
  if (NOT_MAIN.test(name)) s -= 40;
  const archiveStem = stem(inputName);
  const parent = stem(posixDirname(p.path));
  if (name === archiveStem || (parent && name === parent)) s += 15;
  else if (archiveStem.length >= 3 && (name.includes(archiveStem) || archiveStem.includes(name))) s += 6;
  if (p.info?.format === "pe") {
    if (p.info.dll) s -= 50;
    if (p.info.subsystem === "gui") s += 8;
    if (p.info.installer) s -= 30;
  }
  if (p.info?.format === "elf" && p.info.type === "dyn" && !p.info.interpreter) s -= 30;
  s += Math.min(10, Math.log2(Math.max(1, p.size)) / 2);
  return Math.round(s * 10) / 10;
}

async function sniffProgram(tree: FileTree, p: string, size: number): Promise<FoundProgram | undefined> {
  const ext = extname(p);
  if (ext === ".jar") return { path: p, size, kind: "jar", description: "Java archive", score: 0 };
  if (ext === ".swf") return { path: p, size, kind: "swf", description: "Flash movie", score: 0 };
  if ([".iso", ".img", ".ima", ".vfd", ".flp"].includes(ext)) {
    const disk = parseDiskImage(await tree.head(p, 72 * 1024), size, ext);
    if (disk) return { path: p, size, kind: "disk", description: `${disk.type} disk image`, score: 0 };
    return undefined;
  }
  if (ext === ".bat") return { path: p, size, kind: "batch", description: "DOS batch file", score: 0 };
  const head = await tree.head(p, ext === ".exe" ? EXE_HEAD : HEAD);
  if (ext === ".com" && !new Reader(head).startsWith([0x4d, 0x5a])) {
    return size <= 0xff00
      ? { path: p, size, kind: "dos", description: "DOS program (.COM)", score: 0 }
      : undefined;
  }
  const info = parseExecutable(head);
  if (!info) return undefined;
  if (ext !== ".exe" && ext !== ".com" && info.format !== "elf") return undefined;
  const kind = programKind(info);
  if (!kind) return undefined;
  return { path: p, size, kind, description: describeExecutable(info), score: 0 };
}

function topLevelDir(tree: FileTree): string | undefined {
  const firsts = new Set(tree.entries.map((e) => (e.path.includes("/") ? e.path.split("/")[0] : "")));
  if (firsts.size === 1) {
    const only = [...firsts][0]!;
    return only || undefined;
  }
  return undefined;
}

function findIndexHtml(tree: FileTree): string | undefined {
  if (tree.has("index.html")) return "index.html";
  const top = topLevelDir(tree);
  if (top && tree.has(`${top}/index.html`)) return `${top}/index.html`;
  return undefined;
}

async function inspectJar(tree: FileTree, jarPath: string | null, warnings: string[]): Promise<JavaInfo> {
  // jarPath === null means the tree *is* the jar.
  const info: JavaInfo = {};
  let jarTree: FileTree = tree;
  let nested: FileTree | undefined;
  let tempDir: string | undefined;
  if (jarPath !== null) {
    // Nested jar inside an archive: only read it if it is a reasonable size.
    const size = tree.size(jarPath) ?? 0;
    if (size > 256 * 1024 * 1024) return info;
    tempDir = await mkdtemp(path.join(os.tmpdir(), "waa-jar-"));
    const file = path.join(tempDir, "inner.jar");
    await writeFile(file, await tree.read(jarPath));
    try {
      nested = await openTree(file);
      jarTree = nested;
    } catch {
      await rm(tempDir, { recursive: true, force: true });
      return info;
    }
  }
  try {
    if (jarTree.has("META-INF/MANIFEST.MF")) {
      const mf = parseManifest(new TextDecoder().decode(await jarTree.read("META-INF/MANIFEST.MF")));
      info.mainClass = mf["Main-Class"];
      if (mf["Class-Path"]) info.classPath = mf["Class-Path"].split(/\s+/).filter(Boolean);
    }
    const mainPath = info.mainClass ? `${info.mainClass.replace(/\./g, "/")}.class` : undefined;
    const sample =
      mainPath && jarTree.has(mainPath)
        ? mainPath
        : jarTree.entries.find((e) => e.path.endsWith(".class"))?.path;
    if (sample) {
      const bytes = await jarTree.read(sample);
      info.javaVersion = classFileJavaVersion(bytes);
      const text = new TextDecoder("latin1").decode(bytes);
      info.swing = text.includes("javax/swing") || text.includes("java/awt");
      info.javafx = text.includes("javafx/");
    }
    if (!info.mainClass)
      warnings.push("The JAR manifest has no Main-Class; pass the class to run with --main-class.");
    if (info.javafx) warnings.push("JavaFX is not supported by CheerpJ; Swing/AWT apps work best.");
    if (info.javaVersion && info.javaVersion > 17) {
      warnings.push(
        `Compiled for Java ${info.javaVersion}; CheerpJ supports Java 8, 11 and 17. Recompile with --release 17 or lower.`,
      );
    }
  } finally {
    await nested?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
  return info;
}

async function inspectElectron(tree: FileTree, appRoot: string): Promise<ElectronInfo> {
  const info: ElectronInfo = { appRoot, usesNodeInRenderer: false };
  const prefix = appRoot ? `${appRoot}/` : "";
  const pkgPath = `${prefix}package.json`;
  if (!tree.has(pkgPath)) return info;
  try {
    const pkg = JSON.parse(new TextDecoder().decode(await tree.read(pkgPath))) as { main?: string };
    const main = (pkg.main ?? "index.js").replace(/^\.\//, "");
    const mainPath = tree.has(`${prefix}${main}`)
      ? `${prefix}${main}`
      : tree.has(`${prefix}${main}.js`)
        ? `${prefix}${main}.js`
        : undefined;
    info.main = mainPath;
    if (mainPath) {
      const src = new TextDecoder().decode(await tree.read(mainPath));
      if (/nodeIntegration\s*:\s*true/.test(src)) info.usesNodeInRenderer = true;
      const url = src.match(/loadURL\(\s*["'`](https?:\/\/[^"'`]+)["'`]/);
      if (url) info.remoteUrl = url[1];
      const file = src.match(/loadFile\(\s*(?:path\.join\([^,]+,\s*)?["'`]([^"'`]+\.html?)["'`]/);
      if (file) {
        const candidate = `${prefix}${file[1]!.replace(/^\.?\//, "")}`;
        if (tree.has(candidate)) info.page = candidate;
      }
    }
  } catch {
    // fall through to heuristics
  }
  if (!info.page) {
    const html = tree.entries
      .filter(
        (e) => e.path.startsWith(prefix) && /\.html?$/i.test(e.path) && !e.path.includes("node_modules/"),
      )
      .sort(
        (a, b) =>
          a.path.split("/").length - b.path.split("/").length || (/index\.html?$/i.test(a.path) ? -1 : 1),
      );
    info.page = html[0]?.path;
  }
  return info;
}

function emptyReport(tree: FileTree, size: number): ScanReport {
  return {
    schema: 1,
    input: { name: tree.name, size, container: tree.container, files: tree.entries.length },
    kind: "unknown",
    summary: "",
    programs: [],
    warnings: tree.skipped.length
      ? [`Skipped ${tree.skipped.length} entries with unsafe paths or symlinks.`]
      : [],
  };
}

function kindForProgram(kind: ProgramKind): InputKind {
  switch (kind) {
    case "dos":
    case "batch":
      return "dos-program";
    case "win16":
    case "win32":
    case "win64":
    case "win-arm":
    case "dotnet":
      return "windows-program";
    case "linux":
      return "linux-program";
    case "macos":
      return "macos-program";
    case "jar":
      return "java-app";
    case "swf":
      return "flash-movie";
    case "disk":
      return "disk-image";
  }
}

async function classifySingle(tree: FileTree, report: ScanReport): Promise<void> {
  const name = tree.entries[0]!.path;
  const size = tree.entries[0]!.size;
  const ext = extname(name);
  let head = await tree.head(name, HEAD);
  const r = new Reader(head);
  report.entry = name;

  if (r.startsWith([0x4d, 0x5a]) || r.startsWith([0x5a, 0x4d])) {
    head = await tree.head(name, EXE_HEAD);
  }
  const exe = parseExecutable(head);
  if (exe) {
    report.executable = exe;
    const pk = programKind(exe);
    report.kind = pk ? kindForProgram(pk) : "unknown";
    report.summary = `${describeExecutable(exe)}: ${name}`;
    if (pk)
      report.programs.push({ path: name, size, kind: pk, description: describeExecutable(exe), score: 100 });
    if (exe.format === "lx")
      report.warnings.push("LX executables are usually OS/2 programs, which are not supported.");
    return;
  }
  if (ext === ".com" && size <= 0xff00) {
    report.kind = "dos-program";
    report.executable = { format: "dos", extended: false };
    report.summary = `DOS program (.COM): ${name}`;
    report.programs.push({ path: name, size, kind: "dos", description: "DOS program (.COM)", score: 100 });
    return;
  }
  if (ext === ".bat") {
    report.kind = "dos-program";
    report.summary = `DOS batch file: ${name}`;
    report.warnings.push(
      "A batch file on its own rarely works; upload the whole program folder as a zip instead.",
    );
    report.programs.push({ path: name, size, kind: "batch", description: "DOS batch file", score: 100 });
    return;
  }
  if (isSwf(head)) {
    report.kind = "flash-movie";
    report.swf = parseSwf(head);
    const dims = report.swf?.width ? ` ${report.swf.width}×${report.swf.height}` : "";
    report.summary = `Flash movie (SWF v${report.swf?.version ?? "?"}${dims}): ${name}`;
    if (report.swf?.actionScript3) {
      report.warnings.push("This is an ActionScript 3 movie; Ruffle's AS3 support is good but not complete.");
    }
    report.programs.push({ path: name, size, kind: "swf", description: "Flash movie", score: 100 });
    return;
  }
  if (r.startsWith([0x00, 0x61, 0x73, 0x6d])) {
    report.kind = "wasm-module";
    report.summary = `WebAssembly module: ${name}`;
    return;
  }
  if (r.ascii(0, 2) === "#!") {
    const line = r.ascii(0, 200).split("\n")[0]!;
    const interpreter = line.slice(2).trim().split(/\s+/).pop() ?? "";
    report.kind = "script";
    report.script = { interpreter: posixBasename(interpreter) };
    report.summary = `${posixBasename(interpreter)} script: ${name}`;
    return;
  }
  const disk = parseDiskImage(await tree.head(name, 72 * 1024), size, ext);
  if (disk) {
    report.kind = "disk-image";
    report.disk = disk;
    report.summary = `${disk.type === "iso" ? "CD-ROM" : disk.type === "floppy" ? "Floppy" : "Hard disk"} image (${formatBytes(size)}${
      disk.label ? `, "${disk.label}"` : ""
    }${disk.bootable ? ", bootable" : ""}): ${name}`;
    if (!disk.bootable) report.warnings.push("The disk image does not look bootable.");
    report.programs.push({
      path: name,
      size,
      kind: "disk",
      description: `${disk.type} disk image`,
      score: 100,
    });
    return;
  }
  if (ext === ".html" || ext === ".htm") {
    report.kind = "web-app";
    report.web = { index: name };
    report.summary = `Web page: ${name}`;
    return;
  }
  report.summary = `Unrecognised file: ${name}`;
}

async function classifyTree(tree: FileTree, report: ScanReport, entryOverride?: string): Promise<void> {
  const has = (p: string) => tree.has(p);
  const top = topLevelDir(tree);
  const inTop = (p: string) => (has(p) ? p : top && has(`${top}/${p}`) ? `${top}/${p}` : undefined);

  if (inTop(".jsdos/dosbox.conf")) {
    report.kind = "jsdos-bundle";
    report.summary = `js-dos bundle: ${tree.name}`;
    return;
  }
  if (has("AndroidManifest.xml") && tree.entries.some((e) => /^classes\d*\.dex$/.test(e.path))) {
    report.kind = "android-app";
    const abis = [
      ...new Set(
        tree.entries
          .map((e) => /^lib\/([^/]+)\/[^/]+\.so$/.exec(e.path)?.[1])
          .filter((a): a is string => !!a),
      ),
    ].sort();
    report.android = { abis };
    try {
      Object.assign(report.android, readAndroidManifest(await tree.read("AndroidManifest.xml")));
    } catch (err) {
      report.warnings.push(`Could not read AndroidManifest.xml: ${(err as Error).message}`);
    }
    const { package: pkg, versionName } = report.android;
    report.summary = `Android app (APK): ${pkg ?? tree.name}${versionName ? ` ${versionName}` : ""}`;
    return;
  }
  if (tree.entries.some((e) => /^Payload\/[^/]+\.app\//.test(e.path))) {
    report.kind = "ios-app";
    report.summary = `iOS app (IPA): ${tree.name}`;
    return;
  }
  const isJar =
    tree.container === "zip" &&
    has("META-INF/MANIFEST.MF") &&
    (extname(tree.name) === ".jar" || tree.entries.some((e) => e.path.endsWith(".class")));
  if (isJar) {
    report.kind = "java-app";
    report.java = await inspectJar(tree, null, report.warnings);
    report.summary = `Java application${report.java.mainClass ? ` (${report.java.mainClass})` : ""}${
      report.java.javaVersion ? `, Java ${report.java.javaVersion}` : ""
    }: ${tree.name}`;
    return;
  }
  if (tree.container === "asar") {
    report.kind = "electron-app";
    report.electron = await inspectElectron(tree, "");
    report.summary = `Electron app (asar): ${tree.name}`;
    report.entry = report.electron.page;
    return;
  }
  const electronRoot = tree.entries
    .map((e) => e.path.match(/^(?:(.+)\/)?resources\/app\/package\.json$/))
    .find(Boolean);
  if (electronRoot) {
    const appRoot = `${electronRoot[1] ? `${electronRoot[1]}/` : ""}resources/app`;
    report.kind = "electron-app";
    report.electron = await inspectElectron(tree, appRoot);
    report.summary = `Electron app: ${tree.name}`;
    report.entry = report.electron.page;
    return;
  }
  const nestedAsar = tree.entries.find((e) => /(^|\/)resources\/app\.asar$/.test(e.path));
  if (nestedAsar) {
    report.kind = "electron-app";
    report.summary = `Electron app: ${tree.name}`;
    report.electron = { appRoot: nestedAsar.path, usesNodeInRenderer: false };
    if (nestedAsar.size <= 512 * 1024 * 1024) {
      const inner = await readAsar(bufferSource(await tree.read(nestedAsar.path)));
      report.warnings.push(
        `Found ${inner.length} files in ${nestedAsar.path}; pass that app.asar directly for a detailed scan.`,
      );
    }
    return;
  }

  // Look for runnable programs.
  const programs: FoundProgram[] = [];
  let elfProbes = 0;
  for (const e of tree.entries) {
    const ext = extname(e.path);
    const candidate =
      [".exe", ".com", ".bat", ".jar", ".swf", ".iso", ".img", ".ima", ".vfd", ".flp"].includes(ext) ||
      (ext === "" && e.size > 52 && elfProbes++ < 2000) ||
      [".bin", ".run", ".x86", ".x86_64", ".appimage"].includes(ext);
    if (!candidate) continue;
    try {
      const found = await sniffProgram(tree, e.path, e.size);
      if (!found) continue;
      const info =
        found.kind === "dos" ||
        found.kind.startsWith("win") ||
        found.kind === "dotnet" ||
        found.kind === "linux"
          ? parseExecutable(await tree.head(e.path, found.kind === "linux" ? HEAD : EXE_HEAD))
          : undefined;
      found.score = scoreProgram({ ...found, info }, tree.name);
      programs.push(found);
    } catch {
      report.warnings.push(`Could not read ${e.path}.`);
    }
  }
  programs.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  report.programs = programs;

  const index = findIndexHtml(tree);
  const winOrDos = programs.filter((p) => p.kind !== "batch" && p.kind !== "macos");
  if (index && (winOrDos.length === 0 || index === "index.html")) {
    report.kind = "web-app";
    report.web = { index };
    report.entry = index;
    report.summary = `Static web app (${index}): ${tree.name}`;
    return;
  }

  let chosen: FoundProgram | undefined;
  if (entryOverride) {
    if (!tree.has(entryOverride)) throw new UserError(`--entry ${entryOverride} is not in the input.`);
    chosen =
      programs.find((p) => p.path === entryOverride) ??
      (await sniffProgram(tree, entryOverride, tree.size(entryOverride) ?? 0)) ??
      undefined;
    if (!chosen) throw new UserError(`--entry ${entryOverride} is not a program we can run.`);
  } else {
    // Prefer the batch file that shares the archive's name over generic picks, otherwise skip batch files.
    chosen = programs.find((p) => p.kind !== "batch") ?? programs[0];
  }
  if (!chosen) {
    report.summary = `No runnable program found in ${tree.name} (${tree.entries.length} files).`;
    return;
  }
  report.entry = chosen.path;
  report.kind = kindForProgram(chosen.kind);
  if (chosen.kind === "jar") {
    report.java = await inspectJar(tree, chosen.path, report.warnings);
  } else if (chosen.kind === "swf") {
    report.swf = parseSwf(await tree.head(chosen.path, HEAD));
  } else if (chosen.kind === "disk") {
    report.disk = parseDiskImage(await tree.head(chosen.path, 72 * 1024), chosen.size, extname(chosen.path));
  } else if (chosen.kind !== "batch") {
    report.executable = parseExecutable(await tree.head(chosen.path, EXE_HEAD));
  }
  report.summary = `${chosen.description}: ${chosen.path} (in ${tree.name}, ${tree.entries.length} files)`;
  const runnerUp = programs.find((p) => p !== chosen && p.kind !== "batch");
  if (!entryOverride && runnerUp && chosen.score - runnerUp.score < 8) {
    report.warnings.push(
      `Several programs look like the main one; picked ${chosen.path}. Use --entry to choose another (e.g. ${runnerUp.path}).`,
    );
  }
}

export async function scanTree(
  tree: FileTree,
  options: { entry?: string; size?: number } = {},
): Promise<ScanReport> {
  const size = options.size ?? tree.entries.reduce((n, e) => n + e.size, 0);
  const report = emptyReport(tree, size);
  if (tree.container === "file") await classifySingle(tree, report);
  else await classifyTree(tree, report, options.entry);
  postChecks(report, tree);
  return report;
}

/** Imports that resolve only through the Universal CRT / VC++ 2015+ runtime. */
export function needsUcrt(imports: readonly string[]): boolean {
  return imports.some((i) => /^(api-ms-win-crt-|ucrtbase\.dll|vcruntime140|msvcp140)/.test(i));
}

function postChecks(report: ScanReport, tree: FileTree): void {
  const exe = report.executable;
  if (exe?.format === "pe") {
    if (exe.installer) {
      report.warnings.push(
        "This looks like an installer. It may run, but publishing the installed program (zip the install folder) works far better.",
      );
    }
    const gl = exe.imports.filter((i) =>
      /^(opengl32|d3d8|d3d9|d3d10|d3d11|d3d12|dxgi|vulkan-1)\.dll$/.test(i),
    );
    if (gl.length) {
      report.warnings.push(
        `Imports ${gl.join(", ")}: 3D acceleration is not available in the browser runtime, so this program may fail to start.`,
      );
    }
    if (exe.dll) report.warnings.push("This is a DLL, not a program.");
    const shipsUcrt = tree.entries.some((e) =>
      /(^|\/)(api-ms-win-crt-runtime-l1-1-0|ucrtbase)\.dll$/i.test(e.path),
    );
    if (needsUcrt(exe.imports) && !shipsUcrt) {
      report.warnings.push(
        "Uses the Universal C Runtime (api-ms-win-crt-*.dll / vcruntime140.dll), which the browser build of Wine does not include. " +
          "Zip the program together with those DLLs (from the Visual C++ Redistributable), or rebuild it against msvcrt.",
      );
    }
  }
  if (exe?.format === "elf" && exe.arch !== "x86") {
    report.warnings.push(`Linux ${exe.arch} binaries cannot run in the browser yet (only 32-bit x86).`);
  }
}

/** Scan a path on disk. The returned tree stays open; close it when done. */
export async function scanInput(input: string, options: ScanOptions = {}): Promise<ScanResult> {
  const st = await stat(input).catch(() => undefined);
  if (!st) throw new UserError(`Input not found: ${input}`);
  const tree = await openTree(input, { displayName: options.displayName, limits: options.limits });
  try {
    const report = await scanTree(tree, { entry: options.entry, size: st.isFile() ? st.size : undefined });
    if (st.isFile() && !options.noHash) report.input.sha256 = await sha256File(input);
    return { report, tree, inputPath: input };
  } catch (err) {
    await tree.close();
    throw err;
  }
}
