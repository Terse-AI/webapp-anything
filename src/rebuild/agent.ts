import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  MessageCreateParamsBase,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { getBackend, planFor } from "../backends/index.js";
import { Browser } from "../browser/cdp.js";
import { findChrome } from "../browser/chrome.js";
import { buildApp } from "../build/build.js";
import { resolveTarget } from "../check/runner.js";
import type { RuntimeProvider } from "../runtimes/cache.js";
import { scanInput } from "../scan/scan.js";
import { UserError } from "../util/errors.js";
import { type Logger, silentLogger } from "../util/log.js";
import { McpClient, type McpTool, parseMcpSpec } from "./mcp.js";
import { type AgentTool, createTools, type Workspace } from "./tools.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Lets the API retry a request on another model when the requested one is overloaded. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** One model turn. The real client streams it; tests script it. */
export interface ModelClient {
  turn(params: MessageCreateParamsBase, onText?: (delta: string) => void): Promise<BetaMessage>;
}

/** The Claude API through the official SDK (reads ANTHROPIC_API_KEY). */
export async function anthropicClient(
  apiKey = process.env.ANTHROPIC_API_KEY,
  /** For tests: a stand-in for the network. */
  transport?: { fetch: typeof fetch; baseURL?: string },
): Promise<ModelClient> {
  if (!apiKey) {
    throw new UserError(
      "waa rebuild calls the Claude API and needs ANTHROPIC_API_KEY.",
      "Create a key at https://console.anthropic.com/ and export ANTHROPIC_API_KEY=… (usage is billed to that account).",
    );
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey,
    maxRetries: 4,
    ...(transport ? { fetch: transport.fetch, baseURL: transport.baseURL ?? "https://api.test" } : {}),
  });
  return {
    async turn(params, onText) {
      try {
        const stream = client.beta.messages.stream(params);
        if (onText) stream.on("text", onText);
        return await stream.finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) {
          throw new UserError(
            "The Claude API rejected ANTHROPIC_API_KEY.",
            "Check the key in the Anthropic console.",
          );
        }
        if (err instanceof Anthropic.PermissionDeniedError) {
          throw new UserError(`This API key cannot use ${params.model}.`, "Pick another model with --model.");
        }
        if (err instanceof Anthropic.BadRequestError)
          throw new UserError(`The Claude API refused the request: ${err.message}`);
        throw err;
      }
    },
  };
}

export interface RebuildOptions {
  input: string;
  outDir: string;
  client: ModelClient;
  runtimes: RuntimeProvider;
  model?: string;
  effort?: Effort;
  maxTurns?: number;
  maxTokens?: number;
  /** The original running in an emulator: a bundle folder or URL. Built automatically when omitted. */
  reference?: string;
  /** Take screenshots (needs Chrome). */
  screenshots?: boolean;
  viewport?: { width: number; height: number };
  /** Stdio MCP servers to offer the agent, as `name=command args…`. */
  mcp?: string[];
  /** Extra instructions from the user. */
  notes?: string;
  /** Let the API fall back to another model when the requested one is unavailable. */
  fallbacks?: boolean;
  force?: boolean;
  log?: Logger;
  onText?: (delta: string) => void;
}

export interface RebuildUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RebuildResult {
  sourceDir: string;
  bundleDir?: string;
  finished: boolean;
  summary?: string;
  stopReason: string;
  turns: number;
  toolCalls: number;
  usage: RebuildUsage;
  models: string[];
}

const MARKER = "rebuild.json";

function systemPrompt(ws: Workspace, tools: AgentTool[]): string {
  const names = new Set(tools.map((t) => t.definition.name));
  const has = (n: string) => names.has(n);
  return `You rebuild desktop programs as native web apps. You are given one program (its files and a scan report) and tools to inspect it${
    has("screenshot_original") ? ", run it in an emulator and take screenshots" : ""
  }. Write a faithful reimplementation that runs in any modern browser.

The web app:
- is plain static files with index.html at the root: HTML, CSS and JavaScript (ES modules are fine), no build step, no frameworks fetched from a CDN, no network access at all. It must work offline from any static host, so every URL is relative.
- reimplements the program; it does not emulate or wrap the original binary.
- matches the original's look (layout, proportions, colours, typography as close as web fonts allow), its controls (mouse and keyboard, menus, dialogs, shortcuts) and its behaviour (rules, scoring, state, edge cases you find in the binary's strings and resources).
- fits a ${ws.viewport.width}×${ws.viewport.height} viewport and scales sensibly to others; keeps settings and saved progress in localStorage.
- may reuse the program's own asset files (copy_input_file) when they are formats browsers display (PNG, GIF, JPEG, BMP, WAV, MP3, OGG, fonts); otherwise redraw them with CSS, SVG or canvas.

Work in this order:
1. Explore: list_input_files, then windows_resources for Windows programs (menus, dialogs and strings are the UI's blueprint), find_strings and read_input_file for the rest.${
    has("screenshot_original")
      ? "\n2. Capture the original's key screens with screenshot_original (start screen, then after the interactions that matter). The screenshot shows the emulator page; the program's screen is the image inside it."
      : "\n2. There is no running original to screenshot; infer the UI from resources and strings."
  }${[...names].some((n) => n.startsWith("mcp_")) ? "\n   The mcp_* tools come from reverse-engineering servers the user attached; use them for disassembly, decompilation and deeper analysis." : ""}
3. Write the app with write_file: complete files, each under about 1,500 lines (split into modules).${
    has("screenshot_rebuild")
      ? "\n4. Check it with screenshot_rebuild, reusing the original's snapshot names so you get a similarity score, fix every JavaScript error and visible difference, and repeat."
      : ""
  }
5. Call finish with an honest summary: what works, how close it is, and what is missing.

Be economical: no exploratory chatter between tool calls, and do not re-read files you just wrote.`;
}

function firstMessage(ws: Workspace, notes: string | undefined): string {
  const scan = { ...ws.scan, programs: ws.scan.programs.slice(0, 20) };
  return [
    `Rebuild this program as a web app.`,
    `Scan report:\n${JSON.stringify(scan, null, 1).slice(0, 20_000)}`,
    notes ? `Notes from the user:\n${notes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function prepareOut(outDir: string, force: boolean | undefined): Promise<void> {
  const entries = await readdir(outDir).catch(() => undefined);
  if (entries?.length && !entries.includes(MARKER) && !force) {
    throw new UserError(`${outDir} is not empty.`, "Pick a new --out folder or pass --force.");
  }
  await mkdir(path.join(outDir, "source"), { recursive: true });
}

/** Run the agent until it calls finish, runs out of turns, or stops. */
export async function rebuildApp(options: RebuildOptions): Promise<RebuildResult> {
  const log = options.log ?? silentLogger;
  const outDir = path.resolve(options.outDir);
  const model = options.model ?? DEFAULT_MODEL;
  const maxTurns = options.maxTurns ?? 80;
  const viewport = options.viewport ?? { width: 800, height: 600 };
  await prepareOut(outDir, options.force);
  const sourceDir = path.join(outDir, "source");

  const { report: scan, tree } = await scanInput(options.input);
  const servers: Server[] = [];
  const mcpClients: McpClient[] = [];
  let browser: Browser | undefined;
  try {
    // The original, running in its emulator, so the agent can see it.
    const screenshots = options.screenshots !== false && !!findChrome();
    if (options.screenshots !== false && !screenshots) log.warn("Chrome not found: screenshots are off.");
    let referenceUrl: string | undefined;
    if (screenshots && options.reference !== "none") {
      let target = options.reference;
      if (!target) {
        const plan = planFor(scan);
        const backend = plan.chosen ? getBackend(plan.chosen.backend) : undefined;
        if (plan.chosen && backend && plan.chosen.backend !== "stream") {
          target = path.join(outDir, "original");
          log.info(`Building the original with the ${backend.title} backend for screenshots…`);
          try {
            await buildApp(
              { input: options.input, outDir: target, force: true, autostart: true },
              { runtimes: options.runtimes, log },
            );
          } catch (err) {
            log.warn(
              `Could not build the original (${(err as Error).message}); continuing without screenshots of it.`,
            );
            target = undefined;
          }
        }
      }
      if (target) {
        const ref = await resolveTarget(target);
        if (ref.server) servers.push(ref.server);
        referenceUrl = ref.url;
      }
    }

    const mcp: { client: McpClient; tools: McpTool[] }[] = [];
    for (const [i, spec] of (options.mcp ?? []).entries()) {
      const { name, command, args } = parseMcpSpec(spec, i);
      log.info(`Starting MCP server ${name}: ${command} ${args.join(" ")}`);
      const client = await McpClient.spawn(name, command, args);
      mcpClients.push(client);
      const tools = await client.listTools();
      log.info(`  ${tools.length} tools from ${name}`);
      mcp.push({ client, tools });
    }

    const ws: Workspace = {
      tree,
      scan,
      sourceDir,
      workDir: outDir,
      viewport,
      referenceUrl,
      browser: screenshots
        ? async () => {
            browser ??= await Browser.launch({ windowSize: viewport });
            return browser;
          }
        : undefined,
      runtimes: options.runtimes,
      mcp,
    };
    const tools = createTools(ws);
    const byName = new Map(tools.map((t) => [t.definition.name, t]));

    const messages: BetaMessageParam[] = [{ role: "user", content: firstMessage(ws, options.notes) }];
    const usage: RebuildUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const models = new Set<string>();
    let turns = 0;
    let toolCalls = 0;
    let nudges = 0;
    let summary: string | undefined;
    let stopReason = "max_turns";

    while (turns < maxTurns && summary === undefined) {
      turns++;
      const params: MessageCreateParamsBase = {
        model,
        max_tokens: options.maxTokens ?? 32_000,
        system: systemPrompt(ws, tools),
        messages,
        tools: tools.map((t) => t.definition),
        thinking: { type: "adaptive" },
        output_config: { effort: options.effort ?? "high" },
        // Cache the growing conversation: every turn re-reads the same prefix.
        cache_control: { type: "ephemeral" },
        ...(options.fallbacks === false ? {} : { betas: [FALLBACK_BETA], fallbacks: "default" as const }),
      };
      const msg = await options.client.turn(params, options.onText);
      models.add(msg.model);
      usage.inputTokens += msg.usage.input_tokens;
      usage.outputTokens += msg.usage.output_tokens;
      usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += msg.usage.cache_creation_input_tokens ?? 0;
      messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });

      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) log.info(block.text.trim());
      }
      const uses = msg.content.filter((b) => b.type === "tool_use");
      stopReason = msg.stop_reason ?? "unknown";

      if (msg.stop_reason === "refusal") {
        log.warn("The model declined to continue this rebuild.");
        break;
      }
      if (msg.stop_reason === "model_context_window_exceeded") {
        log.warn("The conversation outgrew the model's context window.");
        break;
      }
      if (msg.stop_reason === "pause_turn") continue;

      if (!uses.length) {
        if (msg.stop_reason === "max_tokens") {
          messages.push({ role: "user", content: "Your reply was cut off. Continue where you stopped." });
          continue;
        }
        if (nudges++ < 2) {
          messages.push({
            role: "user",
            content: "Keep going with the tools until the web app is done, then call finish.",
          });
          continue;
        }
        stopReason = "stopped";
        break;
      }

      const results: BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        toolCalls++;
        const t = byName.get(use.name);
        if (msg.stop_reason === "max_tokens" && use === uses[uses.length - 1]) {
          // The last call's input was cut off mid-stream; never run a partial write.
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content:
              "This call was cut off by max_tokens before its input was complete. Send it again, splitting large files.",
          });
          continue;
        }
        if (!t) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: `Unknown tool ${use.name}.`,
          });
          continue;
        }
        const label =
          typeof (use.input as { path?: unknown }).path === "string"
            ? ` ${(use.input as { path: string }).path}`
            : "";
        log.info(`→ ${use.name}${label}`);
        const r = await t.run(use.input as Record<string, unknown>);
        if (r.isError) log.debug(`  ${use.name} failed`, { content: r.content });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        });
        if (r.finished) summary = r.finished.summary;
      }
      messages.push({ role: "user", content: results });
      if (summary !== undefined) stopReason = "finished";
    }

    // Package whatever was written, so even a partial rebuild can be previewed.
    let bundleDir: string | undefined;
    const hasIndex = await readFile(path.join(sourceDir, "index.html")).then(
      () => true,
      () => false,
    );
    if (hasIndex) {
      bundleDir = path.join(outDir, "bundle");
      await buildApp(
        {
          input: sourceDir,
          outDir: bundleDir,
          backend: "web",
          force: true,
          title: scan.input.name.replace(/\.[^.]+$/, ""),
        },
        { runtimes: options.runtimes, log },
      );
    }
    const result: RebuildResult = {
      sourceDir,
      bundleDir,
      finished: summary !== undefined,
      summary,
      stopReason,
      turns,
      toolCalls,
      usage,
      models: [...models],
    };
    await writeFile(
      path.join(outDir, MARKER),
      `${JSON.stringify({ schema: 1, input: scan.input, model, ...result, sourceDir: "source", bundleDir: bundleDir ? "bundle" : undefined }, null, 2)}\n`,
    );
    await writeFile(path.join(outDir, "transcript.json"), JSON.stringify(redactImages(messages), null, 1));
    return result;
  } finally {
    await browser?.close().catch(() => {});
    for (const s of servers) s.close();
    for (const c of mcpClients) c.close();
    await tree.close();
  }
}

/** The conversation without base64 screenshots (they are saved under screens/). */
function redactImages(messages: BetaMessageParam[]): unknown {
  return JSON.parse(
    JSON.stringify(messages, (key, value) =>
      key === "data" && typeof value === "string" && value.length > 200
        ? `<${value.length} base64 chars>`
        : value,
    ),
  );
}
