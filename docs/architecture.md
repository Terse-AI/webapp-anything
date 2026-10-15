# Architecture

```
input (file | folder | zip | asar)
   │
   ▼
scan/tree.ts      FileTree: one read-only view of every kind of input; zips are read through the
   │              central directory without unpacking (zip64, CRC checks, path-traversal guard)
   ▼
scan/scan.ts      ScanReport: kind, entry program, parsed headers, every candidate program ranked,
   │              warnings (installer, 3D APIs, UCRT, non-8.3 names, …)
   ▼
backends/index.ts planFor(): every backend scores the report; the best one (or --backend) is chosen
   │
   ▼
backends/*.ts     build(): packs the program for its runtime and describes the player page
   │   ▲
   │   └── runtimes/cache.ts   pinned runtimes from npm/GitHub, hash-verified, cached per user
   ▼
build/bundle.ts   BundleWriter: index.html (player shell), waa/, runtime/<id>@<version>/, sw.js,
   │              manifest.webmanifest, _headers, vercel.json, THIRD-PARTY-NOTICES.md, waa.json
   ▼
publish/          server (PUT bundle zip) | github-pages (git push) | dir (copy)
server/           waa serve: upload UI + API, content-addressed storage, app hosting
```

## The player shell

Every static bundle (except `web`/`electron`) uses the same page: `assets/player/player.js` provides
`window.WAA` with `start()` (cross-origin isolation, then the play button), `status()`, `progress()`, `ready()`,
`fail()`, `loadScript()` and `fetchWithProgress()`. Backends only supply the stage markup and a short boot module
that receives its settings as `WAA.config.data`.

The play button is deliberate. It gives the browser the user gesture it needs for audio, and it avoids
downloading tens of megabytes for crawlers and link previews. `--autostart` skips it.

## Cross-origin isolation

Runtimes that use `SharedArrayBuffer` (CheerpX, threaded Boxedwine) need `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`. Bundles declare this in `waa.json` under
`requirements.crossOriginIsolation`:

- `waa serve` and `waa preview` send the headers.
- `_headers` (Netlify, Cloudflare Pages) and `vercel.json` carry them.
- Elsewhere (GitHub Pages, plain file servers), `sw.js` adds them. The player registers the worker and reloads
  once. If isolation still fails, it explains what the host needs to change.

## Runtime cache

`RuntimeCache` downloads every source of a runtime (npm tarballs are checked against their SRI hash, URLs against
sha256), lays the files out in `runtimes/<id>@<version>/` through a temporary folder and an atomic rename, and
records per-file hashes so `waa runtimes verify` can re-check them. The cache lives in `WAA_CACHE_DIR`, or the
platform cache folder by default.

| Variable | Effect |
| --- | --- |
| `WAA_CACHE_DIR` | cache location |
| `WAA_OFFLINE=1` | never download; fail if a runtime is missing |
| `WAA_NPM_REGISTRY` | npm registry mirror |
| `WAA_RUNTIME_MIRROR` | base URL tried before the original source (files named as in `downloads/`) |

## Server storage

```
<data>/
├── token               publish token (0600)
├── apps/<slug>.json    app record: manifest, file → {hash, size}, sha256 of the delete key
├── blobs/ab/abcdef…    file contents by sha256 (shared by all apps)
├── uploads/            scanned uploads waiting to be published (expire after an hour)
├── cache/              runtime cache (unless WAA_CACHE_DIR is set)
└── tmp/
```

Records and blobs are written to temporary files and renamed into place, so a crash never leaves a half-written
app. Deleting an app triggers a blob garbage collection. One server process per data folder.
