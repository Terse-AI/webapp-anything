import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaToolResultBlockParam,
  MessageCreateParamsBase,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import * as fx from "../scripts/fixtures.mjs";
import { findChrome } from "../src/browser/chrome.js";
import { anthropicClient, FALLBACK_BETA, type ModelClient, rebuildApp } from "../src/rebuild/agent.js";
import { parseMcpSpec, splitCommand } from "../src/rebuild/mcp.js";
import { findStrings, hexdump, outputPath, validateInput } from "../src/rebuild/tools.js";
import { RuntimeCache } from "../src/runtimes/cache.js";
import { FakeRuntimes, tempDir, writeFileTemp, writeTree } from "./helpers.js";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> };
type Script = (params: MessageCreateParamsBase, turn: number) => { content: Block[]; stop?: string };

/** A model that follows a script; records every request it receives. */
class ScriptedModel implements ModelClient {
  readonly requests: MessageCreateParamsBase[] = [];
  private n = 0;
  constructor(private readonly script: Script[]) {}
  async turn(params: MessageCreateParamsBase): Promise<BetaMessage> {
    // Snapshot: the agent keeps appending to the same array.
    this.requests.push(structuredClone(params));
    const step = this.script[this.n++];
    if (!step) throw new Error("The script ran out of turns");
    const { content, stop } = step(params, this.n);
    let id = 0;
    const blocks = content.map((b) =>
      b.type === "text"
        ? { type: "text", text: b.text, citations: null }
        : { type: "tool_use", id: `toolu_${this.n}_${id++}`, name: b.name, input: b.input },
    ) as BetaContentBlock[];
    return {
      id: `msg_${this.n}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: blocks,
      stop_reason: (stop ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn")) as never,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    } as unknown as BetaMessage;
  }
}

const use = (name: string, input: Record<string, unknown> = {}): Block => ({ type: "tool_use", name, input });

/** The tool results the agent sent back in the latest request. */
function results(params: MessageCreateParamsBase): BetaToolResultBlockParam[] {
  const last = params.messages[params.messages.length - 1]!;
  return (last.content as BetaToolResultBlockParam[]).filter((b) => b.type === "tool_result");
}
const textOf = (r: BetaToolResultBlockParam) =>
  (Array.isArray(r.content) ? r.content : [{ type: "text", text: r.content ?? "" }])
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");

const minesweeper = () =>
  writeTree({
    "WINMINE.EXE": fx.peExe({
      resources: [
        {
          type: 4,
          id: 500,
          data: fx.rcMenu([{ text: "&Game", items: [{ text: "&Beginner", id: 521 }] }]),
        },
        { type: 6, id: 1, data: fx.rcStringTable({ 1: "Minesweeper" }) },
      ],
    }),
    "README.TXT": "Find the mines!",
  });

const INDEX = `<!doctype html><title>Minesweeper</title><canvas id="c" width="160" height="160"></canvas>
<script type="module" src="game.js"></script>`;

describe("rebuild agent", () => {
  it("explores, writes a web app inside its folder and packages it", async () => {
    const outDir = path.join(await tempDir(), "rebuild");
    const model = new ScriptedModel([
      () => ({
        content: [
          { type: "text", text: "Looking at the program." },
          use("list_input_files"),
          use("windows_resources", { path: "WINMINE.EXE" }),
          use("read_input_file", { path: "WINMINE.EXE", as: "hex", length: 32 }),
          use("find_strings", { path: "WINMINE.EXE", contains: "mine" }),
          use("write_file", { path: "../escape.txt", content: "x" }),
          use("write_file", { path: "a.txt", content: "x", mode: "append" }),
          use("read_input_file", { path: "MISSING.DAT" }),
        ],
      }),
      (params) => {
        const r = results(params);
        expect(r).toHaveLength(7);
        expect(textOf(r[0]!)).toMatch(/WINMINE\.EXE/);
        expect(textOf(r[1]!)).toContain('"text": "&Beginner"');
        expect(textOf(r[2]!)).toContain("00000000  4d 5a");
        expect(textOf(r[3]!)).toContain("W Minesweeper");
        expect(r[4]!.is_error).toBe(true);
        expect(textOf(r[4]!)).toMatch(/not an allowed path/);
        expect(textOf(r[5]!)).toMatch(/Unknown field "mode"/);
        expect(r[6]!.is_error).toBe(true);
        return {
          content: [
            use("finish", { summary: "too early" }),
            use("write_file", { path: "index.html", content: INDEX }),
            use("write_file", { path: "game.js", content: "document.title = 'Minesweeper';" }),
            use("copy_input_file", { from: "README.TXT", to: "assets/readme.txt" }),
          ],
        };
      },
      (params) => {
        const r = results(params);
        expect(textOf(r[0]!)).toMatch(/no index.html yet/);
        return { content: [use("list_files"), use("finish", { summary: "Board, menu and timer rebuilt." })] };
      },
    ]);

    const result = await rebuildApp({
      input: await minesweeper(),
      outDir,
      client: model,
      runtimes: new FakeRuntimes(await tempDir()),
      screenshots: false,
    });
    expect(result).toMatchObject({
      finished: true,
      summary: "Board, menu and timer rebuilt.",
      turns: 3,
      stopReason: "finished",
    });
    expect(result.usage).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 240,
      cacheWriteTokens: 60,
    });
    expect(await readFile(path.join(outDir, "source/assets/readme.txt"), "utf8")).toBe("Find the mines!");
    await expect(stat(path.join(path.dirname(outDir), "escape.txt"))).rejects.toThrow();
    expect(await readFile(path.join(outDir, "bundle/index.html"), "utf8")).toContain("game.js");
    expect(JSON.parse(await readFile(path.join(outDir, "bundle/waa.json"), "utf8")).backend.id).toBe("web");
    const report = JSON.parse(await readFile(path.join(outDir, "rebuild.json"), "utf8"));
    expect(report).toMatchObject({ finished: true, model: "claude-opus-5-5", bundleDir: "bundle" });

    // What went over the wire.
    const first = model.requests[0]!;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.thinking).toEqual({ type: "adaptive" });
    expect(first.output_config).toEqual({ effort: "high" });
    expect(first.cache_control).toEqual({ type: "ephemeral" });
    expect(first.betas).toEqual([FALLBACK_BETA]);
    expect(first.fallbacks).toBe("default");
    expect(first.tool_choice).toBeUndefined();
    const names = first.tools!.map((t) => (t as { name: string }).name);
    expect(names).toEqual([
      "list_input_files",
      "read_input_file",
      "find_strings",
      "windows_resources",
      "write_file",
      "copy_input_file",
      "read_file",
      "list_files",
      "finish",
    ]);
    expect(first.tools!.every((t) => (t as { eager_input_streaming?: boolean }).eager_input_streaming)).toBe(
      true,
    );
    expect(first.system).not.toContain("screenshot_original");
    expect(JSON.stringify(first.messages[0])).toContain('"kind\\": \\"windows-program\\"');
    // Thinking and tool_use blocks go back exactly as received.
    expect(model.requests[1]!.messages[1]!.role).toBe("assistant");
  });

  it("never runs a tool call that max_tokens cut off, and stops on refusals", async () => {
    const outDir = path.join(await tempDir(), "rebuild");
    const model = new ScriptedModel([
      () => ({
        content: [use("write_file", { path: "index.html", content: "<p>half" })],
        stop: "max_tokens",
      }),
      (params) => {
        const [r] = results(params);
        expect(r!.is_error).toBe(true);
        expect(textOf(r!)).toMatch(/cut off/);
        return { content: [{ type: "text", text: "I can't help with that." }], stop: "refusal" };
      },
    ]);
    const result = await rebuildApp({
      input: await minesweeper(),
      outDir,
      client: model,
      runtimes: new FakeRuntimes(await tempDir()),
      screenshots: false,
      fallbacks: false,
      effort: "max",
    });
    expect(result).toMatchObject({ finished: false, stopReason: "refusal", turns: 2, bundleDir: undefined });
    await expect(stat(path.join(outDir, "source/index.html"))).rejects.toThrow();
    expect(model.requests[0]!.betas).toBeUndefined();
    expect(model.requests[0]!.output_config).toEqual({ effort: "max" });
  });

  it("nudges a model that stops talking, then gives up", async () => {
    const say = () => ({ content: [{ type: "text" as const, text: "Done thinking." }] });
    const model = new ScriptedModel([say, say, say]);
    const result = await rebuildApp({
      input: await minesweeper(),
      outDir: path.join(await tempDir(), "r"),
      client: model,
      runtimes: new FakeRuntimes(await tempDir()),
      screenshots: false,
    });
    expect(result).toMatchObject({ finished: false, stopReason: "stopped", turns: 3 });
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("call finish");
  });

  it("offers the tools of attached MCP servers", async () => {
    const server = await writeFileTemp(
      "fake-mcp.mjs",
      `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
console.log("not json: servers sometimes log here");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") reply(m.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (m.method === "tools/list") reply(m.id, { tools: [{ name: "decompile", description: "Decompile a function", inputSchema: { type: "object", properties: { fn: { type: "string" } }, required: ["fn"] } }] });
  else if (m.method === "tools/call") reply(m.id, { content: [{ type: "text", text: "int " + m.params.arguments.fn + "() { return 42; }" }] });
});`,
    );
    const model = new ScriptedModel([
      (params) => {
        expect(params.tools!.map((t) => (t as { name: string }).name)).toContain("mcp_rea_decompile");
        expect(params.system).toContain("mcp_* tools");
        return { content: [use("mcp_rea_decompile", { fn: "WinMain" })] };
      },
      (params) => {
        expect(textOf(results(params)[0]!)).toBe("int WinMain() { return 42; }");
        return {
          content: [
            use("write_file", { path: "index.html", content: INDEX }),
            use("finish", { summary: "ok" }),
          ],
        };
      },
    ]);
    const result = await rebuildApp({
      input: await minesweeper(),
      outDir: path.join(await tempDir(), "r"),
      client: model,
      runtimes: new FakeRuntimes(await tempDir()),
      screenshots: false,
      mcp: [`rea="${process.execPath}" "${server}"`],
    });
    expect(result.finished).toBe(true);
  });

  it("refuses to take over unrelated folders", async () => {
    const dir = await writeTree({ "keep.txt": "mine" });
    await expect(
      rebuildApp({
        input: await minesweeper(),
        outDir: dir,
        client: new ScriptedModel([]),
        runtimes: new FakeRuntimes(await tempDir()),
        screenshots: false,
      }),
    ).rejects.toThrow(/not empty/);
  });
});

describe("Claude API client", () => {
  it("streams one turn through the SDK with the beta header and fallbacks", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "list_files", input: {} },
      },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream", "request-id": "req_1" },
      });
    }) as typeof fetch;
    const client = await anthropicClient("sk-ant-test", { fetch: fakeFetch });
    const deltas: string[] = [];
    const msg = await client.turn(
      {
        model: "claude-opus-5-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        cache_control: { type: "ephemeral" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      },
      (d) => deltas.push(d),
    );
    expect(request!.url).toBe("https://api.test/v1/messages?beta=true");
    expect(request!.headers.get("anthropic-beta")).toBe(FALLBACK_BETA);
    expect(request!.headers.get("x-api-key")).toBe("sk-ant-test");
    expect(request!.body).toMatchObject({
      stream: true,
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
    });
    expect(request!.body.betas).toBeUndefined();
    expect(deltas.join("")).toBe("Hello");
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("explains a missing or rejected key", async () => {
    await expect(anthropicClient("")).rejects.toThrow(/ANTHROPIC_API_KEY/);
    const denied = (async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      )) as typeof fetch;
    const client = await anthropicClient("sk-ant-bad", { fetch: denied });
    await expect(
      client.turn({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/rejected ANTHROPIC_API_KEY/);
  });
});

describe("rebuild tools", () => {
  it("confines writes to the output folder", async () => {
    const root = await tempDir();
    expect(await outputPath(root, "js/game.js")).toBe(path.join(root, "js/game.js"));
    for (const bad of ["../x", "/etc/passwd", "a/../../x", "a\\\\b", "", ".", "a/./b", "C:x"]) {
      await expect(outputPath(root, bad)).rejects.toThrow();
    }
    const outside = await tempDir();
    await symlink(outside, path.join(root, "link"));
    await expect(outputPath(root, "link/x.js")).rejects.toThrow(/outside/);
    await writeFile(path.join(outside, "target"), "x");
    await symlink(path.join(outside, "target"), path.join(root, "file.js"));
    await expect(outputPath(root, "file.js")).rejects.toThrow(/symbolic link/);
  });

  it("validates inputs against the tool schema", () => {
    const schema = {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        length: { type: "integer" },
        as: { type: "string", enum: ["text", "hex"] },
      },
      required: ["path"],
    };
    expect(validateInput(schema, { path: "a", length: 3, as: "hex" })).toBeUndefined();
    expect(validateInput(schema, {})).toMatch(/Missing required field "path"/);
    expect(validateInput(schema, { path: 1 })).toMatch(/must be a string/);
    expect(validateInput(schema, { path: "a", length: 1.5 })).toMatch(/integer/);
    expect(validateInput(schema, { path: "a", as: "bin" })).toMatch(/one of/);
    expect(validateInput(schema, [])).toMatch(/object/);
  });

  it("finds ASCII and UTF-16 strings and dumps hex", () => {
    const data = new Uint8Array([
      0,
      ...new TextEncoder().encode("Hello there"),
      0,
      0,
      0x57,
      0,
      0x69,
      0,
      0x64,
      0,
      0x65,
      0,
      0x21,
      0,
      0,
    ]);
    const found = findStrings(data, 5);
    expect(found).toEqual([
      { offset: 1, text: "Hello there", wide: false },
      { offset: 14, text: "Wide!", wide: true },
    ]);
    expect(hexdump(new Uint8Array([0x4d, 0x5a, 0x90]), 16)).toBe(`00000010  4d 5a 90${" ".repeat(39)}  MZ.`);
  });

  it("parses --mcp specs", () => {
    expect(parseMcpSpec("rea=npx -y rea-mcp --root 'My Docs'", 0)).toEqual({
      name: "rea",
      command: "npx",
      args: ["-y", "rea-mcp", "--root", "My Docs"],
    });
    expect(parseMcpSpec("ghidra-mcp", 1)).toEqual({ name: "mcp2", command: "ghidra-mcp", args: [] });
    expect(splitCommand(`a "" 'b c'`)).toEqual(["a", "", "b c"]);
    expect(() => splitCommand(`a "b`)).toThrow(/Unclosed/);
  });
});

const chrome = findChrome();
const runBrowser = !!chrome && process.env.WAA_SKIP_BROWSER_TESTS !== "1";

describe.skipIf(!runBrowser)("rebuild screenshots in Chrome", () => {
  it("shows the agent the original and its rebuild side by side", { timeout: 300_000 }, async () => {
    const outDir = path.join(await tempDir(), "rebuild");
    const model = new ScriptedModel([
      (params) => {
        expect(params.system).toContain("screenshot_original");
        return {
          content: [
            use("screenshot_original", {
              steps: [
                { do: "sleep", ms: 3000 },
                { do: "snapshot", name: "start" },
              ],
            }),
          ],
        };
      },
      (params) => {
        const [r] = results(params);
        expect(r!.is_error).toBeFalsy();
        expect(textOf(r!)).toMatch(/snapshot "start" \(800×600\):\n\[image\]/);
        return {
          content: [
            use("write_file", {
              path: "index.html",
              content: `<!doctype html><body style="margin:0;background:#000;color:#ccc;font:14px monospace">Hello from DOS<script>throw new Error("boom")</script>`,
            }),
            use("screenshot_rebuild", { steps: [{ do: "snapshot", name: "start" }] }),
          ],
        };
      },
      (params) => {
        const r = results(params)[1]!;
        const t = textOf(r);
        expect(t).toMatch(/similarity to the original: 0\.\d{3}/);
        expect(t).toMatch(/JavaScript errors:\n.*boom/);
        return { content: [use("finish", { summary: "done" })] };
      },
    ]);
    const result = await rebuildApp({
      input: await writeFileTemp("HELLO.COM", fx.dosCom("Hello from DOS")),
      outDir,
      client: model,
      runtimes: new RuntimeCache(process.env.WAA_CACHE_DIR),
    });
    expect(result.finished).toBe(true);
    for (const f of [
      "screens/original-start.png",
      "screens/rebuild-start.png",
      "screens/diff-start.png",
      "original/waa.json",
    ]) {
      expect((await stat(path.join(outDir, f))).size).toBeGreaterThan(0);
    }
  });
});
