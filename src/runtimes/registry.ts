/**
 * Every third-party runtime webapp-anything can put into a bundle, pinned to an
 * exact version and verified by hash before use. Bump versions here (and the
 * hashes) in one place; `npm run test:runtimes` re-downloads and re-verifies.
 */

export type VendoredRuntimeId = "js-dos" | "ruffle" | "v86" | "boxedwine" | "xterm";
export type CdnRuntimeId = "cheerpj" | "cheerpx";
export type RuntimeId = VendoredRuntimeId | CdnRuntimeId;

export interface NpmSource {
  kind: "npm";
  name: string;
  version: string;
  /** Subresource-integrity string from the npm registry (sha512-…). */
  integrity: string;
}

export interface UrlSource {
  kind: "url";
  url: string;
  sha256: string;
  /** Logical name, used for the cached download file. */
  name: string;
}

export type RuntimeSource = NpmSource | UrlSource;

/** One file to place in the installed runtime directory. */
export interface LayoutRule {
  /** Source index in `sources`. */
  source: number;
  /** Path inside the source archive (tar/zip), or "" for a raw URL download. */
  from: string | RegExp;
  /** Destination path in the runtime directory; for RegExp rules `$1` etc. are substituted. */
  to: string;
}

export interface VendoredRuntime {
  id: VendoredRuntimeId;
  name: string;
  version: string;
  license: string;
  homepage: string;
  sources: RuntimeSource[];
  layout: LayoutRule[];
  /** License files shipped by webapp-anything itself (assets/licenses/…) copied into the runtime dir. */
  bundledLicenses: { asset: string; to: string }[];
  /** Optional public CDN base URLs mirroring the installed layout (for --runtime cdn). */
  cdn?: Record<string, string>;
}

export interface CdnRuntime {
  id: CdnRuntimeId;
  name: string;
  version: string;
  license: string;
  homepage: string;
  url: string;
  /** Shown to the user whenever a bundle depends on this runtime. */
  notice: string;
}

const JSDOS_VERSION = "8.5.0";
const RUFFLE_VERSION = "0.6.0";
const V86_VERSION = "0.5.465";
export const V86_COMMIT = "7693c56d88527f2855825f7554d37bab2348b05e";
const BOXEDWINE_VERSION = "26R1";

export const VENDORED: Record<VendoredRuntimeId, VendoredRuntime> = {
  "js-dos": {
    id: "js-dos",
    name: "js-dos",
    version: JSDOS_VERSION,
    license: "GPL-2.0",
    homepage: "https://js-dos.com",
    sources: [
      {
        kind: "npm",
        name: "js-dos",
        version: JSDOS_VERSION,
        integrity:
          "sha512-zRc5KKdL4hz/NrQA0cnNJWubeDdoJ//F8B1zsySBCJRaM8F8eRWKhHMqtjgVCDkOUNHQa7CT3oVE024WnqBYIg==",
      },
    ],
    layout: [
      { source: 0, from: "package/dist/js-dos.js", to: "js-dos.js" },
      { source: 0, from: "package/dist/js-dos.css", to: "js-dos.css" },
      {
        source: 0,
        from: /^package\/dist\/emulators\/((?!.*-dbg\.)(?!types\/)[^/]+\.(?:js|mjs|wasm|css|png|woff))$/,
        to: "emulators/$1",
      },
    ],
    bundledLicenses: [{ asset: "licenses/GPL-2.0.txt", to: "LICENSE.txt" }],
    cdn: { base: `https://cdn.jsdelivr.net/npm/js-dos@${JSDOS_VERSION}/dist/` },
  },
  ruffle: {
    id: "ruffle",
    name: "Ruffle",
    version: RUFFLE_VERSION,
    license: "MIT OR Apache-2.0",
    homepage: "https://ruffle.rs",
    sources: [
      {
        kind: "npm",
        name: "@ruffle-rs/ruffle",
        version: RUFFLE_VERSION,
        integrity:
          "sha512-P2X1zDENBoiLt2ZjPcsUzaDxoR7fVF2e1U/bi7hbIAQEjkykxljSoG8AgbywHvlVVzL9Y5tIZMRqDwIm31jgPA==",
      },
    ],
    layout: [
      { source: 0, from: /^package\/([^/]+\.(?:js|wasm))$/, to: "$1" },
      { source: 0, from: "package/LICENSE_MIT", to: "LICENSE_MIT" },
      { source: 0, from: "package/LICENSE_APACHE", to: "LICENSE_APACHE" },
    ],
    bundledLicenses: [],
    cdn: { base: `https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@${RUFFLE_VERSION}/` },
  },
  v86: {
    id: "v86",
    name: "v86",
    version: V86_VERSION,
    license: "BSD-2-Clause (SeaBIOS: LGPL-3.0)",
    homepage: "https://github.com/copy/v86",
    sources: [
      {
        kind: "npm",
        name: "v86",
        version: V86_VERSION,
        integrity:
          "sha512-rMbIXL73ZaES+P90D2G78rGmEPsGbqdOoR3vMaux1OIH3m2Shjn/eZW8zczBNBYvC7LIZi2DIkOV+C8pH7dVZg==",
      },
      {
        kind: "url",
        name: "seabios.bin",
        url: `https://raw.githubusercontent.com/copy/v86/${V86_COMMIT}/bios/seabios.bin`,
        sha256: "73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98",
      },
      {
        kind: "url",
        name: "vgabios.bin",
        url: `https://raw.githubusercontent.com/copy/v86/${V86_COMMIT}/bios/vgabios.bin`,
        sha256: "a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880",
      },
      {
        kind: "url",
        name: "bios-COPYING.LESSER",
        url: `https://raw.githubusercontent.com/copy/v86/${V86_COMMIT}/bios/COPYING.LESSER`,
        sha256: "a853c2ffec17057872340eee242ae4d96cbf2b520ae27d903e1b2fef1a5f9d1c",
      },
    ],
    layout: [
      { source: 0, from: "package/build/libv86.js", to: "build/libv86.js" },
      { source: 0, from: "package/build/v86.wasm", to: "build/v86.wasm" },
      { source: 0, from: "package/build/v86-fallback.wasm", to: "build/v86-fallback.wasm" },
      { source: 0, from: "package/LICENSE", to: "LICENSE" },
      { source: 1, from: "", to: "bios/seabios.bin" },
      { source: 2, from: "", to: "bios/vgabios.bin" },
      { source: 3, from: "", to: "bios/COPYING.LESSER" },
    ],
    bundledLicenses: [],
    cdn: {
      base: `https://cdn.jsdelivr.net/npm/v86@${V86_VERSION}/`,
      bios: `https://cdn.jsdelivr.net/gh/copy/v86@${V86_COMMIT}/bios/`,
    },
  },
  boxedwine: {
    id: "boxedwine",
    name: "Boxedwine",
    version: BOXEDWINE_VERSION,
    license: "GPL-2.0",
    homepage: "https://github.com/danoon2/Boxedwine",
    sources: [
      {
        kind: "url",
        name: "Boxedwine26R1Web.zip",
        url: "https://github.com/danoon2/Boxedwine/releases/download/26R1.0/Boxedwine26R1Web.zip",
        sha256: "ebc634e921f7c65980a7094f3efad84873cede8011eb7dd204446ff1de982945",
      },
    ],
    layout: [
      { source: 0, from: /^SingleThreaded\/(boxedwine(?:-shell)?\.(?:js|wasm|css))$/, to: "st/$1" },
      { source: 0, from: /^MultiThreaded\/(boxedwine(?:-shell)?\.(?:js|wasm|css))$/, to: "mt/$1" },
      { source: 0, from: "SingleThreaded/boxedwine.zip", to: "fs/wine6.zip" },
      { source: 0, from: "Wine11/boxedwine.zip", to: "fs/wine11.zip" },
    ],
    bundledLicenses: [{ asset: "licenses/GPL-2.0.txt", to: "LICENSE.txt" }],
  },
  xterm: {
    id: "xterm",
    name: "xterm.js",
    version: "6.0.0",
    license: "MIT",
    homepage: "https://xtermjs.org",
    sources: [
      {
        kind: "npm",
        name: "@xterm/xterm",
        version: "6.0.0",
        integrity:
          "sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg==",
      },
      {
        kind: "npm",
        name: "@xterm/addon-fit",
        version: "0.11.0",
        integrity:
          "sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g==",
      },
    ],
    layout: [
      { source: 0, from: "package/lib/xterm.js", to: "xterm.js" },
      { source: 0, from: "package/css/xterm.css", to: "xterm.css" },
      { source: 0, from: "package/LICENSE", to: "LICENSE" },
      { source: 1, from: "package/lib/addon-fit.js", to: "addon-fit.js" },
    ],
    bundledLicenses: [],
    cdn: { base: "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/" },
  },
};

export const CDN: Record<CdnRuntimeId, CdnRuntime> = {
  cheerpj: {
    id: "cheerpj",
    name: "CheerpJ",
    version: "4.3",
    license: "Proprietary — free for personal, open-source and evaluation use",
    homepage: "https://cheerpj.com",
    url: "https://cjrtnc.leaningtech.com/4.3/loader.js",
    notice:
      "Java apps run on CheerpJ, loaded from Leaning Technologies' CDN. It is free for personal projects, open-source software and evaluations; commercial use needs a license (https://cheerpj.com/licensing/).",
  },
  cheerpx: {
    id: "cheerpx",
    name: "CheerpX",
    version: "1.3.9",
    license: "Proprietary — free for personal and open-source use",
    homepage: "https://cheerpx.io",
    url: "https://cxrtnc.leaningtech.com/1.3.9/cx.esm.js",
    notice:
      "Linux programs run on CheerpX, loaded from Leaning Technologies' CDN. It is free for personal and open-source projects; commercial use needs a license (https://cheerpx.io/docs/licensing).",
  },
};

/** Root filesystem image CheerpX streams on demand for dynamically linked programs. */
export const CHEERPX_DEBIAN_DISK = "wss://disks.webvm.io/debian_large_20230522_5044875331.ext2";

export function runtimeDirName(rt: { id: string; version: string }): string {
  return `${rt.id}@${rt.version}`;
}
