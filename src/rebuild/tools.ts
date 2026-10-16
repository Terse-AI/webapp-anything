import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import type {
  BetaImageBlockParam,
  BetaTextBlockParam,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Browser } from "../browser/cdp.js";
import { buildApp } from "../build/build.js";
import { diffImages, similarity } from "../check/diff.js";
import { encodePng, type Image } from "../check/png.js";
import { runScenario } from "../check/runner.js";
import { parseScenario, type Step } from "../check/scenario.js";
import { readPeResources } from "../formats/peres.js";
import type { RuntimeProvider } from "../runtimes/cache.js";
import type { FileTree } from "../scan/tree.js";
import type { ScanReport } from "../scan/types.js";
import { startPreview } from "../server/preview.js";
import type { McpClient, McpTool } from "./mcp.js";

export type ToolContent = BetaTextBlockParam | BetaImageBlockParam;

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** Set by `finish`: the agent is done. */
  finished?: { summary: string };
}

export interface AgentTool {
  definition: BetaTool;
  run(input: Record<string, unknown>): Promise<ToolResult>;
}

export interface Workspace {
  tree: FileTree;
  scan: ScanReport;
  /** Where the agent writes the web app. */
  sourceDir: string;
  /** Where screenshots and the rebuilt bundle go. */
  workDir: string;
  viewport: { width: number; height: number };
  /** The original program running in an emulator (bundle URL), for screenshots. */
  referenceUrl?: string;
  /** Lazily launched shared browser; undefined disables the screenshot tools. */
  browser?: () => Promise<Browser>;
  runtimes: RuntimeProvider;
  mcp: { client: McpClient; tools: McpTool[] }[];
}

const MAX_TEXT = 60_000;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FILES = 300;
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9 _.@()+,-]+(?:\/[A-Za-z0-9 _.@()+,-]+)*$/;

const text = (t: string): ToolContent => ({
  type: "text",
  text: t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n… (truncated)` : t,
});
const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const png = (bytes: Uint8Array): ToolContent => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: Buffer.from(bytes).toString("base64") },
});

// --- input validation -------------------------------------------------------------------------
// eager_input_streaming sends tool input before the API validates it, so check it ourselves.

type Schema = {
  type: "object";
  properties: Record<string, { type: string; enum?: string[]; items?: unknown; description?: string }>;
  required?: string[];
  additionalProperties?: boolean;
};

export function validateInput(schema: Schema, input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return "Input must be a JSON object.";
  const obj = input as Record<string, unknown>;
  for (const key of schema.required ?? []) if (!(key in obj)) return `Missing required field "${key}".`;
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key];
    if (!prop) return `Unknown field "${key}".`;
    const ok =
      prop.type === "string"
        ? typeof value === "string"
        : prop.type === "integer"
          ? Number.isInteger(value)
          : prop.type === "boolean"
            ? typeof value === "boolean"
            : prop.type === "array"
              ? Array.isArray(value)
              : prop.type === "object"
                ? typeof value === "object" && value !== null && !Array.isArray(value)
                : true;
    if (!ok) return `Field "${key}" must be ${prop.type === "integer" ? "an integer" : `a ${prop.type}`}.`;
    if (prop.enum && !prop.enum.includes(value as string))
      return `Field "${key}" must be one of ${prop.enum.join(", ")}.`;
  }
  return undefined;
}

function tool(
  name: string,
  description: string,
  schema: Schema,
  run: (input: Record<string, unknown>) => Promise<ToolResult>,
): AgentTool {
  return {
    definition: {
      name,
      description,
      input_schema: { ...schema, additionalProperties: false } as BetaTool["input_schema"],
      eager_input_streaming: true,
    },
    async run(input) {
      const problem = validateInput(schema, input);
      if (problem) return fail(problem);
      try {
        return await run(input);
      } catch (err) {
        return fail(`${name} failed: ${(err as Error).message}`);
      }
    },
  };
}

// --- helpers ------------------------------------------------------------------------------------

export function hexdump(bytes: Uint8Array, base = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${(base + i).toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

/** Printable ASCII and UTF-16LE runs of at least `min` characters, with their file offsets. */
export function findStrings(bytes: Uint8Array, min = 5): { offset: number; text: string; wide: boolean }[] {
  const out: { offset: number; text: string; wide: boolean }[] = [];
  const printable = (b: number) => (b >= 0x20 && b < 0x7f) || b === 0x09;
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && printable(bytes[i]!)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= min)
        out.push({ offset: start, text: String.fromCharCode(...bytes.subarray(start, i)), wide: false });
      start = -1;
    }
  }
  for (const parity of [0, 1]) {
    start = -1;
    let chars = "";
    for (let i = parity; i + 1 <= bytes.length; i += 2) {
      const lo = bytes[i]!;
      const hi = i + 1 < bytes.length ? bytes[i + 1]! : 1;
      if (hi === 0 && printable(lo)) {
        if (start < 0) start = i;
        chars += String.fromCharCode(lo);
      } else {
        if (chars.length >= min) out.push({ offset: start, text: chars, wide: true });
        start = -1;
        chars = "";
      }
    }
    if (chars.length >= min) out.push({ offset: start, text: chars, wide: true });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** Resolve a path the agent gave for its output, refusing anything that could leave `root`. */
export async function outputPath(root: string, rel: string): Promise<string> {
  if (!SAFE_PATH.test(rel) || rel.length > 200) {
    throw new Error(`"${rel}" is not an allowed path (relative, no "..", letters, digits and _ . - only).`);
  }
  const target = path.resolve(root, rel);
  if (!target.startsWith(path.resolve(root) + path.sep))
    throw new Error(`"${rel}" is outside the output folder.`);
  await mkdir(path.dirname(target), { recursive: true });
  // A symlink planted inside the folder must not redirect writes elsewhere.
  const realRoot = await realpath(root);
  const realParent = await realpath(path.dirname(target));
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
    throw new Error(`"${rel}" resolves outside the output folder.`);
  }
  const st = await lstat(target).catch(() => undefined);
  if (st?.isSymbolicLink()) throw new Error(`"${rel}" is a symbolic link.`);
  return target;
}

async function listOutput(root: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else if (e.isFile()) out.push({ path: rel, size: (await lstat(path.join(dir, e.name))).size });
    }
  };
  await walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// --- screenshot steps -----------------------------------------------------------------------------

const STEP_HELP =
  'Steps run in order: {"do":"sleep","ms":1000}, {"do":"click","x":120,"y":80}, {"do":"move","x":1,"y":2}, {"do":"type","text":"hello"}, {"do":"key","key":"Enter"} (Enter, Tab, Escape, Backspace, Space, ArrowUp/Down/Left/Right, F1, F10), {"do":"waitFor","js":"expression"}, {"do":"snapshot","name":"title-screen"}. Coordinates are CSS pixels in the page viewport. Include at least one snapshot.';

const stepsSchema = {
  type: "array",
  description: STEP_HELP,
  items: { type: "object" },
};

// --- the tool set ---------------------------------------------------------------------------------

export function createTools(ws: Workspace): AgentTool[] {
  const originals = new Map<string, Image>();
  let reference: { url: string; server?: Server } | undefined;
  const tools: AgentTool[] = [];

  const entry = (p: string) => {
    if (!ws.tree.has(p)) throw new Error(`No file "${p}" in the input. Use list_input_files.`);
    return ws.tree.read(p);
  };

  tools.push(
    tool(
      "list_input_files",
      "List the files of the original program (path and size in bytes).",
      {
        type: "object",
        properties: { prefix: { type: "string", description: "Only paths starting with this." } },
      },
      async ({ prefix }) => {
        const all = ws.tree.entries.filter((e) => !prefix || e.path.startsWith(prefix as string));
        const lines = all.slice(0, 1000).map((e) => `${String(e.size).padStart(10)}  ${e.path}`);
        if (all.length > 1000) lines.push(`… and ${all.length - 1000} more`);
        return { content: [text(lines.join("\n") || "(no files)")] };
      },
    ),
    tool(
      "read_input_file",
      "Read part of a file of the original program, as UTF-8 text or as a hex dump.",
      {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", description: "Byte offset (default 0)." },
          length: { type: "integer", description: "Bytes to read (default 32768 for text, 2048 for hex)." },
          as: { type: "string", enum: ["text", "hex"] },
        },
        required: ["path"],
      },
      async ({ path: p, offset = 0, length, as = "text" }) => {
        const data = await entry(p as string);
        const start = Math.max(0, offset as number);
        const len = Math.min(
          (length as number | undefined) ?? (as === "hex" ? 2048 : 32768),
          as === "hex" ? 16384 : MAX_TEXT,
        );
        const slice = data.subarray(start, start + len);
        const body = as === "hex" ? hexdump(slice, start) : new TextDecoder().decode(slice);
        return { content: [text(`${p}: bytes ${start}–${start + slice.length} of ${data.length}\n${body}`)] };
      },
    ),
    tool(
      "find_strings",
      "Find printable ASCII and UTF-16 strings in a binary (UI text, file names, error messages, format strings).",
      {
        type: "object",
        properties: {
          path: { type: "string" },
          min_length: { type: "integer" },
          contains: { type: "string", description: "Case-insensitive filter." },
          limit: { type: "integer", description: "Maximum strings (default 400)." },
        },
        required: ["path"],
      },
      async ({ path: p, min_length = 5, contains, limit = 400 }) => {
        const filter = (contains as string | undefined)?.toLowerCase();
        const found = findStrings(await entry(p as string), Math.max(3, min_length as number)).filter(
          (s) => !filter || s.text.toLowerCase().includes(filter),
        );
        const shown = found.slice(0, Math.min(limit as number, 2000));
        const lines = shown.map(
          (s) => `${s.offset.toString(16).padStart(8, "0")} ${s.wide ? "W" : "A"} ${s.text}`,
        );
        if (found.length > shown.length) lines.push(`… ${found.length - shown.length} more`);
        return { content: [text(lines.join("\n") || "(none)")] };
      },
    ),
    tool(
      "windows_resources",
      "Decode the menus, dialogs (with every control's class, text, id and position), string tables and version info of a Windows .exe/.dll.",
      { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async ({ path: p }) => {
        const res = readPeResources(await entry(p as string));
        if (!Object.keys(res.counts).length)
          return { content: [text("No resources (not a PE file, or none embedded).")] };
        return { content: [text(JSON.stringify(res, null, 1))] };
      },
    ),
    tool(
      "write_file",
      "Create or replace a text file of the web app (HTML, CSS, JavaScript, JSON, SVG…). index.html is the entry page.",
      {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      async ({ path: p, content }) => {
        const body = content as string;
        if (Buffer.byteLength(body) > MAX_FILE) return fail("Files are limited to 2 MB; split it up.");
        const existing = await listOutput(ws.sourceDir);
        if (existing.length >= MAX_FILES && !existing.some((e) => e.path === p))
          return fail(`At most ${MAX_FILES} files.`);
        await writeFile(await outputPath(ws.sourceDir, p as string), body);
        return { content: [text(`Wrote ${p} (${Buffer.byteLength(body)} bytes).`)] };
      },
    ),
    tool(
      "copy_input_file",
      "Copy a file of the original program (an image, sound, level or data file) into the web app unchanged.",
      {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
      async ({ from, to }) => {
        const data = await entry(from as string);
        if (data.length > 64 * 1024 * 1024) return fail("Files over 64 MB cannot be copied.");
        await writeFile(await outputPath(ws.sourceDir, to as string), data);
        return { content: [text(`Copied ${from} → ${to} (${data.length} bytes).`)] };
      },
    ),
    tool(
      "read_file",
      "Read a file you wrote for the web app.",
      { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async ({ path: p }) => {
        const file = await outputPath(ws.sourceDir, p as string);
        return { content: [text(await readFile(file, "utf8"))] };
      },
    ),
    tool(
      "list_files",
      "List the files of the web app written so far.",
      { type: "object", properties: {} },
      async () => {
        const files = await listOutput(ws.sourceDir);
        return {
          content: [
            text(files.map((f) => `${String(f.size).padStart(9)}  ${f.path}`).join("\n") || "(empty)"),
          ],
        };
      },
    ),
  );

  if (ws.browser) {
    const browser = ws.browser;
    const run = async (url: string, steps: unknown[], start: boolean) => {
      const scenario = parseScenario({
        schema: 1,
        viewport: ws.viewport,
        steps: [...(start ? [{ do: "start" }] : []), ...steps] as Step[],
      });
      const errors: string[] = [];
      const shots = await runScenario(url, scenario, { browser: await browser(), errors });
      return { shots, errors };
    };

    if (ws.referenceUrl) {
      tools.push(
        tool(
          "screenshot_original",
          `Run the ORIGINAL program (in its emulator) from a fresh start, perform steps, and return the snapshots. ${STEP_HELP}`,
          { type: "object", properties: { steps: stepsSchema }, required: ["steps"] },
          async ({ steps }) => {
            reference ??= { url: ws.referenceUrl! };
            const { shots } = await run(reference.url, steps as unknown[], true);
            const content: ToolContent[] = [];
            for (const s of shots) {
              originals.set(s.name, s.image);
              await writeFile(await outputPath(ws.workDir, `screens/original-${s.name}.png`), s.png);
              content.push(text(`snapshot "${s.name}" (${s.image.width}×${s.image.height}):`), png(s.png));
            }
            return { content };
          },
        ),
      );
    }

    tools.push(
      tool(
        "screenshot_rebuild",
        `Package the web app written so far, open it in a fresh browser tab, perform steps, and return the snapshots plus any JavaScript errors. A snapshot with the same name as an original one also reports its similarity (0–1) to it. ${STEP_HELP}`,
        { type: "object", properties: { steps: stepsSchema }, required: ["steps"] },
        async ({ steps }) => {
          const bundle = path.join(ws.workDir, "bundle");
          await buildApp(
            {
              input: ws.sourceDir,
              outDir: bundle,
              backend: "web",
              force: true,
              offline: false,
              title: ws.scan.input.name,
            },
            { runtimes: ws.runtimes },
          );
          const { server, url } = await startPreview(bundle, { port: 0 });
          try {
            const { shots, errors } = await run(url, steps as unknown[], false);
            const content: ToolContent[] = [];
            for (const s of shots) {
              await writeFile(await outputPath(ws.workDir, `screens/rebuild-${s.name}.png`), s.png);
              const original = originals.get(s.name);
              let note = "";
              if (original) {
                const score = similarity(original, s.image);
                note = ` — similarity to the original: ${score.toFixed(3)}`;
                const d = diffImages(original, s.image);
                if (d.diff) {
                  await writeFile(
                    await outputPath(ws.workDir, `screens/diff-${s.name}.png`),
                    encodePng(d.diff),
                  );
                }
              }
              content.push(
                text(`snapshot "${s.name}" (${s.image.width}×${s.image.height})${note}:`),
                png(s.png),
              );
            }
            content.push(
              text(errors.length ? `JavaScript errors:\n${errors.join("\n")}` : "No JavaScript errors."),
            );
            return { content };
          } finally {
            server.close();
          }
        },
      ),
    );
  }

  for (const { client, tools: mcpTools } of ws.mcp) {
    for (const t of mcpTools) {
      const name = `mcp_${client.name}_${t.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      tools.push({
        definition: {
          name,
          description: `[${client.name} MCP server] ${t.description ?? t.name}`.slice(0, 4000),
          input_schema: (t.inputSchema?.type === "object"
            ? t.inputSchema
            : { type: "object" }) as BetaTool["input_schema"],
        },
        async run(input) {
          try {
            const r = await client.callTool(t.name, input);
            const content: ToolContent[] = [];
            for (const c of r.content ?? []) {
              if (c.type === "text" && typeof c.text === "string") content.push(text(c.text));
              else if (
                c.type === "image" &&
                typeof c.data === "string" &&
                /^image\/(png|jpeg|gif|webp)$/.test(String(c.mimeType))
              ) {
                content.push({
                  type: "image",
                  source: { type: "base64", media_type: c.mimeType as "image/png", data: c.data },
                });
              } else content.push(text(JSON.stringify(c).slice(0, MAX_TEXT)));
            }
            return { content: content.length ? content : [text("(no output)")], isError: r.isError === true };
          } catch (err) {
            return fail((err as Error).message);
          }
        },
      });
    }
  }

  tools.push(
    tool(
      "finish",
      "Call once the web app is complete and checked. Summarise what was rebuilt, how faithful it is, and what is missing.",
      { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
      async ({ summary }) => {
        const files = await listOutput(ws.sourceDir);
        if (!files.some((f) => f.path === "index.html")) return fail("There is no index.html yet.");
        return { content: [text("Done.")], finished: { summary: summary as string } };
      },
    ),
  );
  return tools;
}
