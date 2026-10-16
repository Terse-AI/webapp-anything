import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * A minimal Model Context Protocol client for stdio servers (JSON-RPC 2.0, one message per line).
 * `waa rebuild --mcp` uses it to hand a reverse-engineering server's tools (for example the
 * reverse-engineer-anything MCP server) to the agent.
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderr = "";
  private exited = false;

  private constructor(
    readonly name: string,
    private readonly child: ChildProcess,
    private readonly timeoutMs: number,
  ) {
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => this.onLine(line));
    child.stderr?.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    child.on("exit", (code) => {
      this.exited = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server "${name}" exited (${code}). ${this.stderr.trim().slice(-500)}`));
      }
      this.pending.clear();
    });
  }

  /** Start `command` and complete the MCP handshake. */
  static async spawn(
    name: string,
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Promise<McpClient> {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => reject(new Error(`Could not start MCP server "${name}": ${err.message}`)));
    });
    const client = new McpClient(name, child, options.timeoutMs ?? 120_000);
    try {
      await client.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "webapp-anything", version: "1" },
      });
      client.notify("notifications/initialized");
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Servers sometimes log to stdout; ignore anything that is not JSON-RPC.
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // A request from the server (ping, roots/list…): answer what we can.
      const reply =
        msg.method === "ping"
          ? { jsonrpc: "2.0", id: msg.id, result: {} }
          : msg.method === "roots/list"
            ? { jsonrpc: "2.0", id: msg.id, result: { roots: [] } }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
      this.write(reply);
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`MCP ${this.name}: ${msg.error.message ?? "error"}`));
    else p.resolve(msg.result);
  }

  private write(msg: unknown) {
    if (!this.exited) this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private notify(method: string, params?: unknown) {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`MCP server "${this.name}" is not running.`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request<{ tools: McpTool[]; nextCursor?: string }>(
        "tools/list",
        cursor ? { cursor } : {},
      );
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return this.request<McpCallResult>("tools/call", { name, arguments: args });
  }

  close() {
    if (!this.exited) this.child.kill();
  }
}

/** Parse `name=command arg…` (or just `command arg…`) from the --mcp option. */
export function parseMcpSpec(spec: string, index: number): { name: string; command: string; args: string[] } {
  const m = /^([A-Za-z][A-Za-z0-9_-]{0,15})=(.+)$/.exec(spec.trim());
  const name = m ? m[1]! : `mcp${index + 1}`;
  const words = splitCommand(m ? m[2]! : spec);
  if (!words.length) throw new Error(`Empty --mcp command: ${spec}`);
  return { name, command: words[0]!, args: words.slice(1) };
}

/** Split a command line on spaces, honouring single and double quotes. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (quote) throw new Error(`Unclosed quote in: ${line}`);
  if (has || cur) out.push(cur);
  return out;
}
