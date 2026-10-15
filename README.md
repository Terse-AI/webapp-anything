# webapp-anything

**Turn desktop software into a web app you can publish with one command.**

Give it an old DOS game, a Windows `.exe`, a Java `.jar`, a Flash movie, a Linux binary or a bootable disk image.
It works out what the file is, picks a browser runtime that can run it, packs everything into a static website,
and publishes that site to your own server, GitHub Pages or any static host.

```bash
npx webapp-anything build game.zip        # → out/game/, a folder you can host anywhere
npx webapp-anything preview out/game      # → http://127.0.0.1:4173
npx webapp-anything publish out/game --to github-pages --repo you/games
```

[中文说明](README.zh-CN.md)

## What it runs

| Input | Detected as | Runs on | Status |
| --- | --- | --- | --- |
| `.exe`/`.com`/`.bat`, DOS/4GW games, zipped game folders, js-dos bundles | DOS program | [js-dos](https://js-dos.com) (DOSBox → WebAssembly) | stable |
| 16- and 32-bit Windows `.exe` (GDI, DirectDraw) | Windows program | [Boxedwine](https://github.com/danoon2/Boxedwine) (Wine on an emulated x86) | experimental |
| `.swf` | Flash movie | [Ruffle](https://ruffle.rs) | stable |
| `.jar` (Swing/AWT, Java 8/11/17) | Java app | [CheerpJ](https://cheerpj.com) | stable |
| `.iso`, floppy and hard-disk `.img` | Disk image | [v86](https://github.com/copy/v86) (x86 PC emulator) | stable |
| 32-bit x86 Linux binaries, shell/Python scripts | Linux program | [CheerpX](https://cheerpx.io) + xterm.js | experimental |
| Folder or zip with `index.html` | Web app | published unchanged | stable |
| Electron `app.asar` / `resources/app` | Electron app | renderer with stubbed Electron APIs | experimental |
| 64-bit Windows, 64-bit/ARM Linux GUI apps | – | **stream**: a Docker project that runs the app natively and streams it with [Selkies](https://github.com/selkies-project/selkies) | experimental |
| Android `.apk`, iOS `.ipa`, macOS apps | – | not supported (the scanner explains why) | – |

The samples in [`examples/`](examples) were checked in a real browser: the DOS program prints and waits for a key,
the Flash movie animates, the floppy boots through SeaBIOS, the Win32 and Swing windows respond to clicks, the
Linux binary reads input from the terminal, and the static site is served unchanged. The Electron and stream
backends are covered by tests but have no browser-checked sample yet.

The browser does the work. Apart from the optional `stream` backend, nothing runs on your server: a published app is
a folder of static files.

## Install

Node.js 22.12 or newer.

```bash
npm install -g webapp-anything     # provides the `waa` and `webapp-anything` commands
# or run it without installing:
npx webapp-anything --help
```

From source:

```bash
git clone https://github.com/Terse-AI/webapp-anything && cd webapp-anything
npm ci && npm run build
node dist/cli.js --help
```

## Usage

### 1. Scan: what is this, and what can run it?

```console
$ waa scan keen4.zip
Input    keen4.zip (1.2 MB, zip, 23 files)
Found    DOS program: KEEN4/KEEN4E.EXE (in keen4.zip, 23 files)
Runs on  dos — DOS (js-dos) score 95, stable
         DOS programs run natively in DOSBox.
```

`--json` prints the full report: every program found and how it was ranked, the executable headers (PE imports,
ELF interpreter and libraries, SWF dimensions, JAR main class and Java version…) and warnings such as "this is
an installer" or "needs Direct3D".

### 2. Build a bundle

```bash
waa build keen4.zip                       # out/keen4/
waa build tools.zip --entry bin/tool.exe  # pick the program yourself
waa build movie.swf --title "Intro" --autostart
waa build app.exe --threads               # faster multi-threaded Boxedwine (needs COOP/COEP)
```

A bundle looks like this:

```
out/keen4/
├── index.html              player page: play button, loading, errors, full screen, About
├── app/app.jsdos           your program, packed for the runtime
├── runtime/js-dos@8.5.0/   the runtime, pinned and integrity-checked, with its license
├── waa/                    player script, styles, icon
├── sw.js                   offline cache (and cross-origin isolation where needed)
├── manifest.webmanifest    installable as a PWA
├── _headers, vercel.json   header rules for Netlify, Cloudflare Pages and Vercel
├── THIRD-PARTY-NOTICES.md
└── waa.json                bundle manifest
```

Runtimes are downloaded once from npm or GitHub, checked against hashes pinned in
[`src/runtimes/registry.ts`](src/runtimes/registry.ts), and cached. Use `--runtime cdn` to load js-dos, Ruffle, v86
and xterm.js from jsDelivr instead, which keeps bundles small.

### 3. Publish

```bash
waa publish out/keen4 --to github-pages --repo you/games      # https://you.github.io/games/keen4/
waa publish out/keen4 --to server --server https://apps.example.com --token $WAA_TOKEN
waa publish out/keen4 --to dir --dest /var/www/keen4         # then upload to any static host
waa publish keen4.zip --to server --server …                  # build and publish in one step
```

GitHub Pages cannot send custom headers. Bundles that need cross-origin isolation (Linux programs, threaded
Boxedwine) get it from their service worker, which reloads the page once on the first visit.

## Self-hosted publishing server

`waa serve` runs a small server with an upload page, an HTTP API and app hosting. Anyone with the publish token can
drag a file onto the page and get a link back.

```bash
waa serve --port 8080 --data ./waa-data
# prints the generated publish token on first start (also saved in ./waa-data/token)
```

or with Docker:

```bash
docker compose up -d        # see compose.yaml; data lives in the waa-data volume
```

Files are stored by content hash, so a 40 MB Wine runtime shared by a hundred Windows apps is stored once. The
server sends the right `Content-Type`, `ETag`, `Range` and COOP/COEP headers for each app.

| Option | Env | Default | |
| --- | --- | --- | --- |
| `--port` | `PORT` | `8080` | |
| `--host` | `HOST` | `127.0.0.1` | `0.0.0.0` in Docker |
| `--data` | `WAA_DATA_DIR` | `./waa-data` | apps, blobs, token, runtime cache |
| `--token` | `WAA_TOKEN` | generated | needed to upload, list and delete |
| `--public-url` | `WAA_PUBLIC_URL` | from the `Host` header | base URL used in links |
| `--app-origin` | `WAA_APP_ORIGIN` | same origin | e.g. `https://{slug}.apps.example.com` (recommended, see [Security](#security)) |
| `--max-upload` | `WAA_MAX_UPLOAD_MB` | `1024` | MB |
| `--open-uploads` | `WAA_OPEN_UPLOADS=1` | off | anyone may upload (rate-limited); each app gets its own delete key |
| | `WAA_TRUST_PROXY=1` | off | trust `X-Forwarded-*` from your reverse proxy |

API, for scripts and CI:

```bash
# one shot: upload, build and publish
curl -H "Authorization: Bearer $WAA_TOKEN" --data-binary @game.zip \
  "https://apps.example.com/api/apps?filename=game.zip&title=My%20Game"

# two steps, as the web page does it: scan first, then publish with your choices
curl -H "Authorization: Bearer $WAA_TOKEN" --data-binary @game.zip "…/api/uploads?filename=game.zip"
curl -H "Authorization: Bearer $WAA_TOKEN" -H "Content-Type: application/json" \
  -d '{"upload":"<id>","backend":"dos","slug":"game"}' …/api/apps
```

Also `PUT /api/apps/:slug` (upload a built bundle as a zip; this is what `waa publish --to server` does),
`GET /api/apps`, `GET /api/apps/:slug`, `DELETE /api/apps/:slug`, `GET /api/info` and `GET /healthz`.

## How it works

1. **Scan.** The input is opened as a file tree (single file, folder, zip or asar) without unpacking it. Format
   parsers read only the headers they need: MZ/NE/LE/PE (machine, subsystem, imports, .NET, installer markers),
   ELF (class, machine, `PT_INTERP`, `DT_NEEDED`), Mach-O, SWF, ISO 9660/El Torito, MBR, JAR manifests and class
   versions, Electron `package.json`. In archives, every candidate program is ranked: setup and uninstall tools,
   DLLs and installers rank low; names matching the archive or folder rank high.
2. **Plan.** Each backend scores how well it can run the scan. The best one wins, and `--backend` overrides it.
3. **Build.** The backend packs the program the way its runtime expects (a `.jsdos` bundle with a generated
   `dosbox.conf`, a Wine `C:\files` zip, a tarball for the Linux userland, and so on) and writes a page around the
   shared player.
4. **Publish.** Bundles are plain static sites with a manifest, so any host works. The included server and the
   GitHub Pages publisher handle headers and URLs for you.

See [docs/architecture.md](docs/architecture.md) and [docs/backends.md](docs/backends.md) for details and the
known limits of each runtime.

## Security

- Programs run inside the browser's sandbox (WebAssembly), not on your server. The `stream` backend is the
  exception: it runs the program in a container you start yourself.
- Uploaded apps are arbitrary web content. If you host other people's uploads, serve apps from a separate origin
  with `--app-origin https://{slug}.apps.example.com`, so they cannot reach the server's API or each other's storage.
- Archives are unpacked with path-traversal checks, entry-count and size limits, and CRC verification.
- Runtimes are pinned and hash-verified before use.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Licensing and legal

webapp-anything is MIT-licensed. The runtimes keep their own licenses, which are copied into every bundle:
js-dos and Boxedwine are GPL-2.0, Ruffle is MIT/Apache-2.0, v86 is BSD-2-Clause (SeaBIOS is LGPL-3.0), and
xterm.js is MIT. CheerpJ and CheerpX are proprietary and loaded from Leaning Technologies' CDN; they are free for
personal and open-source use, but commercial use needs a license from Leaning Technologies. `waa build` reminds you
when a bundle depends on them.

**Only publish software you have the right to distribute.** Converting a program does not change its license.

## Development

```bash
npm ci
npm run build          # TypeScript → dist/
npm test               # unit and integration tests (no network)
npm run test:runtimes  # downloads every pinned runtime and checks its hash
npm run lint
npm run examples       # regenerate the sample programs in examples/
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- **AI rebuild backend:** when nothing can run a program, explore it with an agent (for example through
  [REA](https://github.com/morluto/rea)'s MCP tools), write a real web reimplementation, and check its behaviour
  against the original.
- Behaviour checks: record input and screens in the original and replay them against the web build.
- Android through a streamed emulator; Windows 9x guests through DOSBox-X images.
- Saved-game sync between devices.

## License

[MIT](LICENSE)
