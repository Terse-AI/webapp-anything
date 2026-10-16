import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { escapeHtml } from "../build/html.js";
import type { Logger } from "../util/log.js";
import { diffImages, similarity } from "./diff.js";
import { decodePng, encodePng } from "./png.js";
import { resolveTarget, runScenario } from "./runner.js";
import type { Scenario } from "./scenario.js";

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "new" | "updated";
  mismatch?: number;
  threshold: number;
  files: { actual: string; expected?: string; diff?: string };
}

export interface CheckReport {
  target: string;
  passed: boolean;
  results: CheckResult[];
  reportFile: string;
}

const DEFAULT_THRESHOLD = 0.01;

/**
 * Run a scenario against a bundle (or URL) and compare each snapshot with the baseline
 * PNGs in `baselineDir`. `update` (re)writes the baselines instead of failing.
 */
export async function checkTarget(
  target: string,
  scenario: Scenario,
  options: { baselineDir: string; outDir: string; update?: boolean; gpu?: boolean; log?: Logger },
): Promise<CheckReport> {
  const { url, server } = await resolveTarget(target);
  try {
    const snapshots = await runScenario(url, scenario, { log: options.log, gpu: options.gpu });
    await mkdir(options.outDir, { recursive: true });
    await mkdir(options.baselineDir, { recursive: true });
    const results: CheckResult[] = [];
    for (const snap of snapshots) {
      const threshold = snap.threshold ?? DEFAULT_THRESHOLD;
      const actual = path.join(options.outDir, `${snap.name}.actual.png`);
      await writeFile(actual, snap.png);
      const baseline = path.join(options.baselineDir, `${snap.name}.png`);
      const expectedBytes = await readFile(baseline).catch(() => undefined);
      if (options.update || !expectedBytes) {
        await writeFile(baseline, snap.png);
        results.push({
          name: snap.name,
          status: expectedBytes ? "updated" : "new",
          threshold,
          files: { actual, expected: baseline },
        });
        continue;
      }
      const result = diffImages(decodePng(new Uint8Array(expectedBytes)), snap.image);
      const diffFile = path.join(options.outDir, `${snap.name}.diff.png`);
      if (result.diff) await writeFile(diffFile, encodePng(result.diff));
      results.push({
        name: snap.name,
        status: result.mismatch <= threshold ? "pass" : "fail",
        mismatch: result.mismatch,
        threshold,
        files: { actual, expected: baseline, diff: result.diff ? diffFile : undefined },
      });
    }
    const reportFile = path.join(options.outDir, "report.html");
    await writeFile(reportFile, renderCheckReport(target, results, options.outDir));
    return { target, passed: results.every((r) => r.status !== "fail"), results, reportFile };
  } finally {
    server?.close();
  }
}

export interface CompareResult {
  name: string;
  similarity: number;
  files: { a: string; b: string };
}

/**
 * Run the same scenario against two targets (for example a program in its emulator and a
 * web reimplementation of it) and score how alike each pair of snapshots looks (0–1).
 */
export async function compareTargets(
  a: string,
  b: string,
  scenario: Scenario,
  options: { outDir: string; gpu?: boolean; log?: Logger },
): Promise<{ results: CompareResult[]; reportFile: string; average: number }> {
  await mkdir(options.outDir, { recursive: true });
  const run = async (target: string) => {
    const { url, server } = await resolveTarget(target);
    try {
      return await runScenario(url, scenario, { log: options.log, gpu: options.gpu });
    } finally {
      server?.close();
    }
  };
  const left = await run(a);
  const right = await run(b);
  const results: CompareResult[] = [];
  for (const snap of left) {
    const other = right.find((s) => s.name === snap.name);
    if (!other) continue;
    const fa = path.join(options.outDir, `${snap.name}.a.png`);
    const fb = path.join(options.outDir, `${snap.name}.b.png`);
    await writeFile(fa, snap.png);
    await writeFile(fb, other.png);
    results.push({
      name: snap.name,
      similarity: similarity(snap.image, other.image),
      files: { a: fa, b: fb },
    });
  }
  const average = results.length ? results.reduce((n, r) => n + r.similarity, 0) / results.length : 0;
  const reportFile = path.join(options.outDir, "compare.html");
  await writeFile(reportFile, renderCompareReport(a, b, results, average, options.outDir));
  return { results, reportFile, average };
}

const STYLE = `body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#0b0d12;color:#e8ebf2}
h1{font-size:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #262c3b;padding:8px;vertical-align:top;text-align:left}
img{max-width:100%;image-rendering:pixelated;background:#000}.pass{color:#6ce09a}.fail{color:#ff7a7a}.new,.updated{color:#d29922}code{color:#9db8ff}`;

function rel(outDir: string, file?: string): string {
  return file ? escapeHtml(path.relative(outDir, file).split(path.sep).join("/")) : "";
}

function renderCheckReport(target: string, results: CheckResult[], outDir: string): string {
  const rows = results
    .map(
      (r) =>
        `<tr><td><b>${escapeHtml(r.name)}</b><br><span class="${r.status}">${r.status}</span>${
          r.mismatch === undefined
            ? ""
            : `<br>${(r.mismatch * 100).toFixed(2)}% differs (limit ${(r.threshold * 100).toFixed(2)}%)`
        }</td><td>${r.files.expected ? `<img src="${rel(outDir, r.files.expected)}" alt="expected">` : ""}</td><td><img src="${rel(outDir, r.files.actual)}" alt="actual"></td><td>${
          r.files.diff ? `<img src="${rel(outDir, r.files.diff)}" alt="diff">` : ""
        }</td></tr>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>webapp-anything check</title><style>${STYLE}</style>
<h1>Behaviour check: <code>${escapeHtml(target)}</code></h1>
<table><tr><th>Snapshot</th><th>Baseline</th><th>Actual</th><th>Difference</th></tr>${rows}</table>`;
}

function renderCompareReport(
  a: string,
  b: string,
  results: CompareResult[],
  average: number,
  outDir: string,
): string {
  const rows = results
    .map(
      (r) =>
        `<tr><td><b>${escapeHtml(r.name)}</b><br>${(r.similarity * 100).toFixed(1)}% similar</td><td><img src="${rel(outDir, r.files.a)}" alt="a"></td><td><img src="${rel(outDir, r.files.b)}" alt="b"></td></tr>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>webapp-anything compare</title><style>${STYLE}</style>
<h1>Compare: <code>${escapeHtml(a)}</code> vs <code>${escapeHtml(b)}</code></h1>
<p>Average similarity: <b>${(average * 100).toFixed(1)}%</b></p>
<table><tr><th>Snapshot</th><th>A</th><th>B</th></tr>${rows}</table>`;
}
