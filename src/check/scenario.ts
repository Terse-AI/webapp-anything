import { UserError } from "../util/errors.js";

export type Region = "stage" | "page" | { x: number; y: number; width: number; height: number };

export type Step =
  /** Press the player's play button and wait until the runtime reports it is ready. */
  | { do: "start"; timeoutMs?: number }
  | { do: "sleep"; ms: number }
  /** Wait until a JavaScript expression evaluated in the page is truthy. */
  | { do: "waitFor"; js: string; timeoutMs?: number }
  | { do: "click"; x: number; y: number }
  | { do: "move"; x: number; y: number }
  | { do: "type"; text: string }
  | { do: "key"; key: string }
  | { do: "snapshot"; name: string; region?: Region; threshold?: number };

export interface Scenario {
  schema: 1;
  name?: string;
  viewport: { width: number; height: number; scale?: number };
  steps: Step[];
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function num(v: unknown, field: string, min = 0, max = 1e7): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new UserError(`Scenario: ${field} must be a number between ${min} and ${max}.`);
  }
  return v;
}

function str(v: unknown, field: string, maxLen = 10_000): string {
  if (typeof v !== "string" || v.length > maxLen) throw new UserError(`Scenario: ${field} must be a string.`);
  return v;
}

function region(v: unknown, field: string): Region | undefined {
  if (v === undefined || v === "stage" || v === "page") return v;
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    return {
      x: num(r.x, `${field}.x`),
      y: num(r.y, `${field}.y`),
      width: num(r.width, `${field}.width`, 1),
      height: num(r.height, `${field}.height`, 1),
    };
  }
  throw new UserError(`Scenario: ${field} must be "stage", "page" or {x, y, width, height}.`);
}

/** Validate untrusted scenario JSON. */
export function parseScenario(value: unknown): Scenario {
  if (!value || typeof value !== "object") throw new UserError("Scenario must be a JSON object.");
  const v = value as Record<string, unknown>;
  if (v.schema !== 1) throw new UserError("Scenario: schema must be 1.");
  const vp = (v.viewport ?? { width: 800, height: 600 }) as Record<string, unknown>;
  const viewport = {
    width: num(vp.width, "viewport.width", 100, 4000),
    height: num(vp.height, "viewport.height", 100, 4000),
    ...(vp.scale === undefined ? {} : { scale: num(vp.scale, "viewport.scale", 0.5, 4) }),
  };
  if (!Array.isArray(v.steps)) throw new UserError("Scenario: steps must be an array.");
  const names = new Set<string>();
  const steps = v.steps.map((raw, i): Step => {
    const s = raw as Record<string, unknown>;
    const at = `steps[${i}]`;
    switch (s?.do) {
      case "start":
        return {
          do: "start",
          ...(s.timeoutMs === undefined ? {} : { timeoutMs: num(s.timeoutMs, `${at}.timeoutMs`, 1) }),
        };
      case "sleep":
        return { do: "sleep", ms: num(s.ms, `${at}.ms`, 0, 600_000) };
      case "waitFor":
        return {
          do: "waitFor",
          js: str(s.js, `${at}.js`),
          ...(s.timeoutMs === undefined ? {} : { timeoutMs: num(s.timeoutMs, `${at}.timeoutMs`, 1) }),
        };
      case "click":
      case "move":
        return { do: s.do, x: num(s.x, `${at}.x`), y: num(s.y, `${at}.y`) };
      case "type":
        return { do: "type", text: str(s.text, `${at}.text`) };
      case "key":
        return { do: "key", key: str(s.key, `${at}.key`, 32) };
      case "snapshot": {
        const name = str(s.name, `${at}.name`, 64);
        if (!NAME_RE.test(name))
          throw new UserError(`Scenario: ${at}.name may only use letters, digits, . _ and -.`);
        if (names.has(name)) throw new UserError(`Scenario: snapshot name "${name}" is used twice.`);
        names.add(name);
        return {
          do: "snapshot",
          name,
          ...(s.region === undefined ? {} : { region: region(s.region, `${at}.region`) }),
          ...(s.threshold === undefined ? {} : { threshold: num(s.threshold, `${at}.threshold`, 0, 1) }),
        };
      }
      default:
        throw new UserError(
          `Scenario: ${at}.do must be one of start, sleep, waitFor, click, move, type, key, snapshot.`,
        );
    }
  });
  if (!steps.some((s) => s.do === "snapshot"))
    throw new UserError("Scenario needs at least one snapshot step.");
  return { schema: 1, ...(typeof v.name === "string" ? { name: v.name } : {}), viewport, steps };
}

/** A sensible default for a bundle: start it, let it settle, take one picture of the stage. */
export function defaultScenario(settleMs = 3000): Scenario {
  return {
    schema: 1,
    viewport: { width: 800, height: 600 },
    steps: [
      { do: "start" },
      { do: "sleep", ms: settleMs },
      { do: "snapshot", name: "started", region: "stage" },
    ],
  };
}
