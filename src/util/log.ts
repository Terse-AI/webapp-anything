export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  options: { level?: LogLevel; json?: boolean; stream?: NodeJS.WritableStream } = {},
): Logger {
  const min = ORDER[options.level ?? "info"];
  const out = options.stream ?? process.stderr;
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    if (options.json) {
      out.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`);
      return;
    }
    const prefix = level === "error" ? "error: " : level === "warn" ? "warning: " : "";
    const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    out.write(`${prefix}${msg}${extra}\n`);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
