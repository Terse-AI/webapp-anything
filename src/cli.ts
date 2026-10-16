#!/usr/bin/env node
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { BACKENDS, getBackend, planFor } from "./backends/index.js";
import { type BuildRequest, type BuildResult, buildApp } from "./build/build.js";
import type { BackendId } from "./build/manifest.js";
import { MANIFEST_FILE } from "./build/manifest.js";
import { checkTarget, compareTargets } from "./check/check.js";
import { recordScenario } from "./check/record.js";
import { defaultScenario, parseScenario, type Scenario } from "./check/scenario.js";
import { type PublishTarget, publishBundle } from "./publish/index.js";
import { anthropicClient, DEFAULT_MODEL, type Effort, rebuildApp } from "./rebuild/agent.js";
import { RuntimeCache } from "./runtimes/cache.js";
import { CDN, VENDORED, type VendoredRuntimeId } from "./runtimes/registry.js";
import { scanInput } from "./scan/scan.js";
import { startPreview } from "./server/preview.js";
import { closeOnSignals, startServer } from "./server/server.js";
import { packageVersion } from "./util/assets.js";
import { formatBytes } from "./util/bytes.js";
import { errorMessage, UserError } from "./util/errors.js";
import { createLogger } from "./util/log.js";
import { isValidSlug, slugify } from "./util/paths.js";

const log = createLogger({ level: process.env.WAA_DEBUG ? "debug" : "info" });
// `waa scan x | head` closes the pipe early; that is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
const out = (s = "") => process.stdout.write(`${s}\n`);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const yellow = (s: string) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s);

function intArg(name: string, min: number, max: number) {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new InvalidArgumentError(`${name} must be an integer ${min}–${max}.`);
    return n;
  };
}

function slugArg(v: string): string {
  if (!isValidSlug(v)) throw new InvalidArgumentError("use 1–63 lowercase letters, digits and dashes");
  return v;
}

const collect = (v: string, prev: string[]) => [...prev, v];
const backendIds = BACKENDS.map((b) => b.id);

function printWarnings(warnings: string[]): void {
  for (const w of warnings) out(`  ${yellow("!")} ${w}`);
}

const program = new Command()
  .name("waa")
  .description("webapp-anything — turn desktop software into web apps you can publish.")
  .version(packageVersion(), "-v, --version")
  .showHelpAfterError("(run with --help for usage)");

program
  .command("scan")
  .description("Identify a program, archive or folder and show how it would run in the browser.")
  .argument("<input>", "file, folder or archive to inspect")
  .option("-e, --entry <path>", "program inside the input to run")
  .option("--json", "print the scan report as JSON")
  .action(async (input: string, opts: { entry?: string; json?: boolean }) => {
    const { report, tree } = await scanInput(input, { entry: opts.entry });
    await tree.close();
    const plan = planFor(report);
    if (opts.json) {
      out(JSON.stringify({ scan: report, plan }, null, 2));
      return;
    }
    out(
      `${bold("Input")}    ${report.input.name} ${dim(`(${formatBytes(report.input.size)}, ${report.input.container}, ${report.input.files} file${report.input.files === 1 ? "" : "s"})`)}`,
    );
    out(`${bold("Found")}    ${report.summary}`);
    if (report.programs.length > 1) {
      out(
        `${bold("Programs")} ${report.programs
          .slice(0, 6)
          .map((p) => `${p.path} ${dim(`(${p.score})`)}`)
          .join(", ")}${report.programs.length > 6 ? ", …" : ""}`,
      );
    }
    if (plan.chosen) {
      const b = getBackend(plan.chosen.backend)!;
      out(
        `${bold("Runs on")}  ${b.id} — ${b.title} ${dim(`score ${plan.chosen.score}, ${plan.chosen.stability}`)}`,
      );
      for (const r of plan.chosen.reasons) out(`         ${dim(r)}`);
      const others = plan.candidates.filter((c) => c !== plan.chosen && c.score > 0);
      if (others.length)
        out(`${bold("Also")}     ${others.map((c) => `${c.backend} ${dim(`(${c.score})`)}`).join(", ")}`);
    } else {
      out(`${bold("Runs on")}  ${yellow("nothing yet")} — ${plan.unsupported}`);
    }
    printWarnings([...new Set([...report.warnings, ...(plan.chosen?.warnings ?? [])])]);
    if (plan.chosen) out(`\n${dim("Next:")} waa build ${JSON.stringify(input)}`);
  });

function buildCommand(cmd: Command): Command {
  return cmd
    .option("-o, --out <dir>", "output folder (default: ./out/<slug>)")
    .addOption(new Option("-b, --backend <id>", "force a backend").choices(backendIds))
    .option("-e, --entry <path>", "program inside the input to run")
    .option("-t, --title <title>", "app title")
    .option("--slug <slug>", "URL-friendly name", slugArg)
    .addOption(
      new Option("--runtime <mode>", "vendor runtimes into the bundle, or load them from public CDNs")
        .choices(["vendor", "cdn"])
        .default("vendor"),
    )
    .option("--autostart", "start immediately instead of showing a play button")
    .option("--no-offline", "do not install the offline service worker")
    .option("--arg <value>", "argument passed to the program (repeatable)", collect, [])
    .option("--force", "replace a non-empty output folder")
    .addOption(
      new Option("--dos-engine <engine>", "DOS emulator").choices(["dosbox", "dosboxX"]).default("dosbox"),
    )
    .option("--cycles <cycles>", "DOSBox CPU cycles (auto, max or a number)")
    .option("--threads", "multi-threaded Boxedwine (faster; needs COOP/COEP headers)")
    .addOption(
      new Option("--wine <version>", "Wine root filesystem for Windows programs")
        .choices(["6", "11"])
        .default("6"),
    )
    .option("--resolution <WxH>", "Windows screen size, e.g. 1024x768")
    .option("--main-class <class>", "Java class to run instead of the manifest's Main-Class")
    .addOption(new Option("--java <version>", "Java version for CheerpJ").choices(["8", "11", "17"]))
    .option("--memory <MB>", "RAM for the PC emulator", intArg("--memory", 8, 2048))
    .option(
      "--guest <image>",
      "boot this OS disk image (e.g. an installed Windows 98) with the program on D:",
    )
    .addOption(
      new Option("--guest-engine <engine>", "emulator for --guest")
        .choices(["v86", "dosboxX"])
        .default("v86"),
    );
}

interface BuildCliOptions {
  out?: string;
  backend?: BackendId;
  entry?: string;
  title?: string;
  slug?: string;
  runtime: "vendor" | "cdn";
  autostart?: boolean;
  offline: boolean;
  arg: string[];
  force?: boolean;
  dosEngine: "dosbox" | "dosboxX";
  cycles?: string;
  threads?: boolean;
  wine: "6" | "11";
  resolution?: string;
  mainClass?: string;
  java?: "8" | "11" | "17";
  memory?: number;
  guest?: string;
  guestEngine: "v86" | "dosboxX";
  json?: boolean;
}

function toBuildRequest(input: string, o: BuildCliOptions, outDir: string): BuildRequest {
  if (o.cycles && !/^(auto|max|\d{2,7})$/.test(o.cycles))
    throw new UserError("--cycles must be auto, max or a number.");
  return {
    input,
    outDir,
    backend: o.backend,
    entry: o.entry,
    title: o.title,
    slug: o.slug,
    runtime: o.runtime,
    autostart: o.autostart,
    offline: o.offline,
    args: o.arg,
    force: o.force,
    dos: { engine: o.dosEngine, cycles: o.cycles },
    windows: { threads: o.threads === true, wine: o.wine, resolution: o.resolution },
    java: { mainClass: o.mainClass, version: o.java ? (Number(o.java) as 8 | 11 | 17) : undefined },
    disk: { memoryMB: o.memory },
    guest: o.guest,
    guestEngine: o.guestEngine,
  };
}

async function runBuild(input: string, o: BuildCliOptions, outDir: string): Promise<BuildResult> {
  const runtimes = new RuntimeCache(undefined, log);
  return buildApp(toBuildRequest(input, o, outDir), { runtimes, log });
}

async function defaultOutDir(input: string, o: BuildCliOptions): Promise<string> {
  if (o.out) return o.out;
  if (o.slug) return path.join("out", o.slug);
  const { report, tree } = await scanInput(input, { entry: o.entry, noHash: true });
  await tree.close();
  const { defaultTitle } = await import("./build/build.js");
  const { slugify } = await import("./util/paths.js");
  return path.join("out", slugify(o.title ?? defaultTitle(report)));
}

buildCommand(program.command("build"))
  .description("Convert an input into a web bundle (a folder you can host anywhere).")
  .argument("<input>", "file, folder or archive")
  .option("--json", "print the result as JSON")
  .action(async (input: string, o: BuildCliOptions) => {
    const outDir = await defaultOutDir(input, o);
    const result = await runBuild(input, o, outDir);
    if (o.json) {
      out(
        JSON.stringify(
          { outDir: result.outDir, manifest: result.manifest, warnings: result.warnings },
          null,
          2,
        ),
      );
      return;
    }
    const b = getBackend(result.manifest.backend.id)!;
    out(
      `${bold("Built")}    ${result.manifest.app.title} → ${path.relative(process.cwd(), result.outDir) || "."}`,
    );
    out(
      `${bold("Runs on")}  ${b.title}${result.manifest.backend.stability === "experimental" ? dim(" (experimental)") : ""}`,
    );
    out(`${bold("Size")}     ${formatBytes(result.bytes)} in ${result.files} files`);
    if (result.manifest.requirements.crossOriginIsolation) {
      out(
        `${bold("Needs")}    COOP/COEP headers (added automatically by waa serve/preview, _headers and vercel.json)`,
      );
    }
    if (result.manifest.requirements.network.length) {
      out(`${bold("Loads")}    ${result.manifest.requirements.network.join(", ")}`);
    }
    printWarnings(result.warnings);
    const rel = path.relative(process.cwd(), result.outDir) || ".";
    if (result.manifest.type === "container") {
      out(`\n${dim("Next:")} cd ${rel} && docker compose up --build`);
    } else {
      out(
        `\n${dim("Next:")} waa preview ${rel}   ${dim("or")}   waa publish ${rel} --to github-pages --repo you/site`,
      );
    }
  });

program
  .command("preview")
  .description("Serve a bundle locally with the right headers.")
  .argument("<bundle>", "folder produced by `waa build`")
  .option("-p, --port <port>", "port", intArg("--port", 0, 65535), 4173)
  .option("--host <host>", "interface to listen on", "127.0.0.1")
  .action(async (dir: string, o: { port: number; host: string }) => {
    const { url } = await startPreview(dir, { port: o.port, host: o.host });
    out(`Serving ${dir} at ${bold(url)}  ${dim("(Ctrl+C to stop)")}`);
  });

buildCommand(
  program
    .command("publish")
    .description("Publish a bundle (or build and publish an input) to a host.")
    .argument("<path>", "bundle folder, or any input to build first")
    .addOption(
      new Option("--to <target>", "where to publish")
        .choices(["server", "github-pages", "dir"])
        .makeOptionMandatory(),
    )
    .option("--server <url>", "webapp-anything server URL (env WAA_SERVER)")
    .option("--token <token>", "server publish token (env WAA_TOKEN)")
    .option("--repo <owner/name>", "GitHub repository for github-pages")
    .option("--branch <branch>", "branch for github-pages", "gh-pages")
    .option("--path <dir>", "sub-folder inside the GitHub Pages site (default: the slug)")
    .option("--remote <url>", "git remote URL to push to (overrides --repo)")
    .option("--dest <dir>", "destination folder for --to dir"),
).action(
  async (
    target: string,
    o: BuildCliOptions & {
      to: PublishTarget;
      server?: string;
      token?: string;
      repo?: string;
      branch: string;
      path?: string;
      remote?: string;
      dest?: string;
    },
  ) => {
    let bundle = target;
    let temp: string | undefined;
    const isBundle = await stat(path.join(target, MANIFEST_FILE)).then(
      () => true,
      () => false,
    );
    try {
      if (!isBundle) {
        temp = await mkdtemp(path.join(os.tmpdir(), "waa-publish-"));
        const result = await runBuild(target, { ...o, force: true }, temp);
        printWarnings(result.warnings);
        bundle = result.outDir;
      }
      const res = await publishBundle(bundle, {
        to: o.to,
        server: o.server ?? process.env.WAA_SERVER,
        token: o.token ?? process.env.WAA_TOKEN,
        slug: o.slug,
        repo: o.repo,
        remote: o.remote,
        branch: o.branch,
        path: o.path,
        dest: o.dest,
        log,
      });
      out(`${bold("Published")} ${res.url}`);
      for (const n of res.notes) out(`  ${dim(n)}`);
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true });
    }
  },
);

program
  .command("serve")
  .description("Run the self-hosted publishing server (upload page, API and app hosting).")
  .option("-p, --port <port>", "port (env PORT)", intArg("--port", 0, 65535))
  .option("--host <host>", "interface (env HOST)")
  .option("--data <dir>", "data folder (env WAA_DATA_DIR)")
  .option("--token <token>", "publish token (env WAA_TOKEN); generated and saved when omitted")
  .option("--public-url <url>", "external URL of this server (env WAA_PUBLIC_URL)")
  .option(
    "--app-origin <template>",
    "serve apps from another origin, e.g. https://{slug}.apps.example.com (env WAA_APP_ORIGIN)",
  )
  .option(
    "--max-upload <MB>",
    "largest accepted upload (env WAA_MAX_UPLOAD_MB)",
    intArg("--max-upload", 1, 64 * 1024),
  )
  .option("--open-uploads", "let anyone upload without a token (env WAA_OPEN_UPLOADS=1)")
  .addOption(new Option("--log-format <format>", "log format").choices(["text", "json"]))
  .action(
    async (o: {
      port?: number;
      host?: string;
      data?: string;
      token?: string;
      publicUrl?: string;
      appOrigin?: string;
      maxUpload?: number;
      openUploads?: boolean;
      logFormat?: "text" | "json";
    }) => {
      const env = process.env;
      const json = (o.logFormat ?? env.WAA_LOG_FORMAT) === "json";
      const serverLog = createLogger({
        level: env.WAA_DEBUG ? "debug" : "info",
        json,
        stream: process.stdout,
      });
      const running = await startServer({
        port: o.port ?? (env.PORT ? Number(env.PORT) : 8080),
        host: o.host ?? env.HOST ?? "127.0.0.1",
        dataDir: o.data ?? env.WAA_DATA_DIR ?? "waa-data",
        token: o.token ?? env.WAA_TOKEN,
        publicUrl: o.publicUrl ?? env.WAA_PUBLIC_URL,
        appOrigin: o.appOrigin ?? env.WAA_APP_ORIGIN,
        maxUploadBytes:
          (o.maxUpload ?? (env.WAA_MAX_UPLOAD_MB ? Number(env.WAA_MAX_UPLOAD_MB) : 1024)) * 1024 * 1024,
        openUploads: o.openUploads ?? env.WAA_OPEN_UPLOADS === "1",
        log: serverLog,
      });
      closeOnSignals(running, serverLog);
      serverLog.info(`webapp-anything ${packageVersion()} listening on ${running.url}`);
      if (running.generatedToken)
        serverLog.info(`Publish token (saved in the data folder): ${running.token}`);
    },
  );

async function loadScenario(file: string | undefined): Promise<Scenario> {
  if (!file) return defaultScenario();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new UserError(`Scenario file not found: ${file}`);
  }
  try {
    return parseScenario(JSON.parse(raw));
  } catch (err) {
    if (err instanceof SyntaxError) throw new UserError(`${file} is not valid JSON: ${err.message}`);
    throw err;
  }
}

program
  .command("check")
  .description(
    "Behaviour check: run a scenario against a bundle and compare its screens with saved baselines.",
  )
  .argument("<target>", "bundle folder or URL")
  .option("-s, --scenario <file>", "scenario JSON (default: start, wait, snapshot the stage)")
  .option("--baseline <dir>", "folder with baseline PNGs", "waa-baseline")
  .option("--out <dir>", "folder for actual/diff images and report.html", "waa-check")
  .option("--update", "accept the current screens as the new baselines")
  .option("--gpu", "render with the GPU instead of SwiftShader")
  .option("--json", "print results as JSON")
  .action(
    async (
      target: string,
      o: {
        scenario?: string;
        baseline: string;
        out: string;
        update?: boolean;
        gpu?: boolean;
        json?: boolean;
      },
    ) => {
      const scenario = await loadScenario(o.scenario);
      const report = await checkTarget(target, scenario, {
        baselineDir: o.baseline,
        outDir: o.out,
        update: o.update,
        gpu: o.gpu,
        log,
      });
      if (o.json) out(JSON.stringify(report, null, 2));
      else {
        for (const r of report.results) {
          const pct = r.mismatch === undefined ? "" : ` ${(r.mismatch * 100).toFixed(2)}% differs`;
          out(`  ${r.status === "fail" ? yellow("✗") : "✓"} ${r.name.padEnd(20)} ${r.status}${pct}`);
        }
        out(`${bold(report.passed ? "Passed" : "Failed")}  report: ${report.reportFile}`);
      }
      if (!report.passed) process.exitCode = 1;
    },
  );

program
  .command("compare")
  .description(
    "Run one scenario against two targets (e.g. original vs rebuild) and score how alike they look.",
  )
  .argument("<a>", "first bundle folder or URL")
  .argument("<b>", "second bundle folder or URL")
  .option("-s, --scenario <file>", "scenario JSON (default: start, wait, snapshot the stage)")
  .option("--out <dir>", "folder for screenshots and compare.html", "waa-compare")
  .option("--min <ratio>", "fail when average similarity is below this (0–1)")
  .option("--gpu", "render with the GPU instead of SwiftShader")
  .action(
    async (a: string, b: string, o: { scenario?: string; out: string; min?: string; gpu?: boolean }) => {
      const scenario = await loadScenario(o.scenario);
      const res = await compareTargets(a, b, scenario, { outDir: o.out, gpu: o.gpu, log });
      for (const r of res.results) out(`  ${r.name.padEnd(20)} ${(r.similarity * 100).toFixed(1)}% similar`);
      out(`${bold("Average")}  ${(res.average * 100).toFixed(1)}%  report: ${res.reportFile}`);
      if (o.min !== undefined && res.average < Number(o.min)) process.exitCode = 1;
    },
  );

program
  .command("record")
  .description("Open a bundle in Chrome and record what you do as a scenario (F2 marks a snapshot).")
  .argument("<target>", "bundle folder or URL")
  .requiredOption("-o, --out <file>", "where to write the scenario JSON")
  .option("--width <px>", "viewport width", intArg("--width", 320, 4000), 800)
  .option("--height <px>", "viewport height", intArg("--height", 240, 4000), 600)
  .action(async (target: string, o: { out: string; width: number; height: number }) => {
    const session = await recordScenario(target, { viewport: { width: o.width, height: o.height }, log });
    out(
      "Recording. Use the app in the Chrome window; press F2 to mark a snapshot. Close the window (or Ctrl+C) to finish.",
    );
    process.once("SIGINT", () => session.stop());
    const scenario = await session.done;
    await writeFile(o.out, `${JSON.stringify(scenario, null, 2)}\n`);
    out(
      `${bold("Saved")} ${scenario.steps.length} steps to ${o.out}. Check it with: waa check ${target} -s ${o.out} --update`,
    );
  });

program
  .command("rebuild")
  .description(
    "AI rebuild: a Claude agent studies the program (and screenshots of it running) and writes a native web version.",
  )
  .argument("<input>", "program file, folder or archive")
  .option("-o, --out <dir>", "output folder (default: ./rebuild/<name>)")
  .option("--model <id>", "Claude model", DEFAULT_MODEL)
  .addOption(
    new Option("--effort <level>", "how hard the model thinks")
      .choices(["low", "medium", "high", "xhigh", "max"])
      .default("high"),
  )
  .option("--max-turns <n>", "stop after this many model turns", intArg("--max-turns", 1, 500), 80)
  .option("--reference <target>", 'the original as a bundle folder or URL to screenshot ("none" to skip)')
  .option("--no-screenshots", "do not run the original or the rebuild in Chrome")
  .option("--width <px>", "viewport width for screenshots", intArg("--width", 320, 4000), 800)
  .option("--height <px>", "viewport height for screenshots", intArg("--height", 240, 4000), 600)
  .option(
    "--mcp <command>",
    'stdio MCP server whose tools the agent may use, as "name=command args" (repeatable)',
    collect,
    [],
  )
  .option("--notes <text>", "extra instructions for the agent")
  .option("--no-fallbacks", "never let the API answer with a fallback model")
  .option("--force", "reuse a non-empty output folder")
  .option("-y, --yes", "do not ask before calling the (billed) Claude API")
  .action(
    async (
      input: string,
      o: {
        out?: string;
        model: string;
        effort: Effort;
        maxTurns: number;
        reference?: string;
        screenshots: boolean;
        width: number;
        height: number;
        mcp: string[];
        notes?: string;
        fallbacks: boolean;
        force?: boolean;
        yes?: boolean;
      },
    ) => {
      const client = await anthropicClient();
      const outDir =
        o.out ?? path.join("rebuild", slugify(path.basename(input).replace(/\.[^.]+$/, "")) || "app");
      out(
        `${bold("waa rebuild")} sends ${path.basename(input)} (file listings, strings, resources${o.screenshots ? ", screenshots" : ""}) to the Claude API: ${o.model}, effort ${o.effort}, up to ${o.maxTurns} turns. Usage is billed to your Anthropic account.`,
      );
      if (o.fallbacks) {
        out(
          dim(
            "Server-side fallbacks are on: if the model is overloaded the API may answer with another Claude model (--no-fallbacks to turn off).",
          ),
        );
      }
      if (!o.yes) {
        if (!process.stdin.isTTY)
          throw new UserError("Not confirmed.", "Run it in a terminal or pass --yes.");
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question("Continue? [y/N] ");
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) throw new UserError("Cancelled.");
      }
      const result = await rebuildApp({
        input,
        outDir,
        client,
        runtimes: new RuntimeCache(undefined, log),
        model: o.model,
        effort: o.effort,
        maxTurns: o.maxTurns,
        reference: o.reference,
        screenshots: o.screenshots,
        viewport: { width: o.width, height: o.height },
        mcp: o.mcp,
        notes: o.notes,
        fallbacks: o.fallbacks,
        force: o.force,
        log,
      });
      out("");
      out(
        `${bold(result.finished ? "Rebuilt" : "Stopped")} after ${result.turns} turns and ${result.toolCalls} tool calls (${result.stopReason}).`,
      );
      if (result.summary) out(result.summary);
      const u = result.usage;
      out(
        dim(
          `Tokens: ${u.inputTokens} in, ${u.outputTokens} out, ${u.cacheReadTokens} cache reads, ${u.cacheWriteTokens} cache writes. Models: ${result.models.join(", ")}`,
        ),
      );
      if (result.bundleDir) {
        const rel = path.relative(process.cwd(), result.bundleDir) || ".";
        out(
          `\n${dim("Next:")} waa preview ${rel}   ${dim("or compare:")} waa compare ${path.join(path.dirname(rel), "original")} ${rel}`,
        );
      }
      if (!result.finished) process.exitCode = 1;
    },
  );

const runtimes = program.command("runtimes").description("Manage the cached browser runtimes.");
runtimes
  .command("list")
  .description("Show every runtime, its version, license and cache status.")
  .action(async () => {
    const cache = new RuntimeCache(undefined, log);
    out(`${bold("Cache")} ${cache.dir}`);
    for (const id of Object.keys(VENDORED) as VendoredRuntimeId[]) {
      const spec = VENDORED[id];
      const st = await cache.status(id);
      out(
        `  ${spec.name.padEnd(10)} ${spec.version.padEnd(9)} ${spec.license.padEnd(36)} ${st.installed ? `cached (${formatBytes(st.size ?? 0)})` : dim("not cached")}`,
      );
    }
    for (const spec of Object.values(CDN)) {
      out(
        `  ${spec.name.padEnd(10)} ${spec.version.padEnd(9)} ${spec.license.slice(0, 36).padEnd(36)} ${dim(`CDN: ${new URL(spec.url).host}`)}`,
      );
    }
  });
runtimes
  .command("fetch")
  .description("Download and verify runtimes ahead of time (all when none given).")
  .argument("[ids...]", `runtime ids: ${Object.keys(VENDORED).join(", ")}`)
  .action(async (ids: string[]) => {
    const cache = new RuntimeCache(undefined, log);
    const list = (ids.length ? ids : Object.keys(VENDORED)) as VendoredRuntimeId[];
    for (const id of list) {
      if (!VENDORED[id]) throw new UserError(`Unknown runtime: ${id}`);
      const rt = await cache.ensure(id);
      out(`${rt.spec.name} ${rt.spec.version}: ${rt.files.length} files in ${rt.dir}`);
    }
  });
runtimes
  .command("verify")
  .description("Re-hash cached runtime files.")
  .action(async () => {
    const cache = new RuntimeCache(undefined, log);
    let bad = 0;
    for (const id of Object.keys(VENDORED) as VendoredRuntimeId[]) {
      const st = await cache.status(id);
      if (!st.installed) continue;
      const problems = await cache.verify(id);
      out(`${VENDORED[id].name}: ${problems.length ? problems.join(", ") : "ok"}`);
      bad += problems.length;
    }
    if (bad) process.exitCode = 1;
  });
runtimes
  .command("clear")
  .description("Delete cached runtimes (all when none given).")
  .argument("[ids...]")
  .action(async (ids: string[]) => {
    const cache = new RuntimeCache(undefined, log);
    for (const id of (ids.length ? ids : Object.keys(VENDORED)) as VendoredRuntimeId[]) {
      if (!VENDORED[id]) throw new UserError(`Unknown runtime: ${id}`);
      await cache.remove(id);
      out(`removed ${id}`);
    }
  });

program
  .command("backends")
  .description("List the available backends.")
  .action(() => {
    for (const b of BACKENDS) out(`${bold(b.id.padEnd(9))} ${b.title}\n          ${dim(b.runs)}`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof UserError) {
    log.error(err.message);
    if (err.hint) process.stderr.write(`  ${err.hint}\n`);
  } else {
    log.error(errorMessage(err));
    if (process.env.WAA_DEBUG && err instanceof Error) process.stderr.write(`${err.stack}\n`);
  }
  process.exitCode = 1;
});
