import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory holding files shipped with the package (player assets, licenses, UI). */
export const ASSETS_DIR = fileURLToPath(new URL("../../assets/", import.meta.url));

export function assetPath(rel: string): string {
  return path.join(ASSETS_DIR, ...rel.split("/"));
}

let cachedVersion: string | undefined;

export function packageVersion(): string {
  if (!cachedVersion) {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as {
      version: string;
    };
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}
