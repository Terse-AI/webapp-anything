import type { InputKind } from "../scan/types.js";

export type BackendId =
  | "dos"
  | "windows"
  | "flash"
  | "java"
  | "linux"
  | "disk"
  | "web"
  | "electron"
  | "stream";

export interface RuntimeRef {
  id: string;
  name: string;
  version: string;
  license: string;
  homepage: string;
  delivery: "vendored" | "cdn";
  /** Where the runtime lives relative to the bundle (vendored) or its URL (cdn). */
  location: string;
  source?: string;
}

export interface BundleManifest {
  schema: 1;
  generator: { name: "webapp-anything"; version: string };
  /** "static": a folder of web files. "container": a Docker project for streaming. */
  type: "static" | "container";
  app: { title: string; slug: string };
  backend: { id: BackendId; stability: "stable" | "experimental" };
  source: { name: string; size: number; sha256?: string; kind: InputKind; entry?: string };
  runtimes: RuntimeRef[];
  requirements: {
    /** Needs COOP/COEP headers (SharedArrayBuffer). */
    crossOriginIsolation: boolean;
    /** Third-party hosts the page loads code or data from at runtime. */
    network: string[];
  };
  notices: string[];
  createdAt: string;
}

export const MANIFEST_FILE = "waa.json";

export function isBundleManifest(value: unknown): value is BundleManifest {
  const m = value as BundleManifest;
  return (
    !!m &&
    m.schema === 1 &&
    m.generator?.name === "webapp-anything" &&
    (m.type === "static" || m.type === "container") &&
    typeof m.app?.title === "string" &&
    typeof m.backend?.id === "string" &&
    typeof m.requirements?.crossOriginIsolation === "boolean"
  );
}

/** HTTP headers a host should send for every file of this bundle. */
export function bundleHeaders(manifest: Pick<BundleManifest, "requirements">): Record<string, string> {
  const h: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (manifest.requirements.crossOriginIsolation) {
    h["Cross-Origin-Opener-Policy"] = "same-origin";
    h["Cross-Origin-Embedder-Policy"] = "require-corp";
    h["Cross-Origin-Resource-Policy"] = "same-origin";
  }
  return h;
}
