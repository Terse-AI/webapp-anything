import type { BackendId } from "../build/manifest.js";
import type { ScanReport } from "../scan/types.js";
import { diskBackend } from "./disk.js";
import { dosBackend } from "./dos.js";
import { flashBackend } from "./flash.js";
import { javaBackend } from "./java.js";
import { linuxBackend } from "./linux.js";
import { streamBackend } from "./stream.js";
import type { Assessment, Backend } from "./types.js";
import { electronBackend, webBackend } from "./web.js";
import { windowsBackend } from "./windows.js";

export const BACKENDS: readonly Backend[] = [
  dosBackend,
  windowsBackend,
  flashBackend,
  javaBackend,
  diskBackend,
  linuxBackend,
  webBackend,
  electronBackend,
  streamBackend,
];

export function getBackend(id: string): Backend | undefined {
  return BACKENDS.find((b) => b.id === id);
}

export interface Plan {
  chosen?: Assessment;
  candidates: Assessment[];
  /** Why nothing can run it, when `chosen` is undefined. */
  unsupported?: string;
}

const UNSUPPORTED: Partial<Record<ScanReport["kind"], string>> = {
  "android-app":
    "Android apps (APK) need an Android runtime; none runs inside a browser yet. Stream it from a server with an Android emulator such as redroid instead.",
  "ios-app": "iOS apps (IPA) are encrypted and tied to Apple hardware; they cannot be converted.",
  "macos-program": "macOS programs cannot run outside macOS; there is no browser runtime for them.",
  "wasm-module":
    "A bare WebAssembly module needs the JavaScript glue it was built with. Publish the folder containing its HTML page instead.",
  unknown: "This file type is not recognised.",
};

/** Rank every backend for a scan. A forced backend is honoured even if it scores 0. */
export function planFor(scan: ScanReport, force?: BackendId): Plan {
  const candidates = BACKENDS.map((b) => b.assess(scan))
    .filter((a): a is Assessment => !!a)
    .sort((a, b) => b.score - a.score);
  if (force) {
    const forced = candidates.find((c) => c.backend === force);
    if (!forced) return { candidates, unsupported: `The ${force} backend cannot run ${scan.kind}.` };
    return { chosen: forced, candidates };
  }
  const chosen = candidates.find((c) => c.score >= 10);
  if (!chosen) {
    const reason =
      candidates.flatMap((c) => c.warnings)[0] ??
      UNSUPPORTED[scan.kind] ??
      `No backend can run ${scan.kind} yet.`;
    return { candidates, unsupported: reason };
  }
  return { chosen, candidates };
}

export type { Assessment, Backend } from "./types.js";
