# Backends

A backend turns a scan into a bundle. Each one scores the scan (0–100) in `assess()`. The highest score wins,
unless `--backend` forces a choice. Scores below 10 mean "cannot run this".

| Backend | Runtime | Delivery | Needs COOP/COEP | Typical bundle size |
| --- | --- | --- | --- | --- |
| `dos` | js-dos 8.5.0 (DOSBox; DOSBox-X with `--dos-engine dosboxX`) | vendored or jsDelivr | no | ~2.6 MB + program |
| `windows` | Boxedwine 26R1 (Wine 6 or 11 root filesystem) | vendored | only with `--threads` | ~40 MB (Wine 6) / ~52 MB (Wine 11) |
| `flash` | Ruffle 0.6.0 | vendored or jsDelivr | no | ~28 MB |
| `java` | CheerpJ 4.3 | Leaning Technologies CDN | no | program only |
| `disk` | v86 0.5.465 + SeaBIOS | vendored or jsDelivr | no | ~6 MB + image |
| `linux` | CheerpX 1.3.9 + Debian image + xterm.js 6 | CDN (CheerpX), vendored/jsDelivr (xterm) | yes | ~0.5 MB + program |
| `web` | none | – | no | site only |
| `electron` | none (shim) | – | no | renderer files |
| `guest` | v86 or DOSBox-X (js-dos 8.5.0) booting your own OS image | vendored or jsDelivr | no | runtime + your image + program ISO |
| `stream` | Selkies base image (`ghcr.io/linuxserver/baseimage-selkies:debiantrixie`); Android: `budtmo/docker-android:emulator_14.0_v3.7.0-p1` | Docker | – | Docker project |

## dos

- Single programs are renamed to an 8.3 name when needed. Archives keep their layout. The generated
  `.jsdos/dosbox.conf` mounts the bundle as `C:`, changes into the program's folder and starts it (`call` for
  `.bat` files). `--cycles` sets DOSBox CPU speed; `--arg` adds command-line arguments.
- Existing js-dos bundles (`.jsdos`, or any zip/folder with `.jsdos/dosbox.conf`) are used as they are.
- DOS/4GW, DOS/32A, PMODE/W and DJGPP extenders are detected and run normally.
- Saves: js-dos reports every file the program changes; the player keeps them in IndexedDB and puts them back
  on the next visit (or on another device with sync).

## windows

- The program and every file next to it are mounted at `C:\files`, and Wine starts in the program's folder.
- Startup takes 10–60 seconds while Wine boots on the emulated CPU; the page shows a timer and reveals the
  screen when Wine maps the first window.
- Not available in the browser build: OpenGL and Direct3D, 64-bit programs, and .NET (no Wine Mono). Programs
  linked against the Universal CRT (`api-ms-win-crt-*.dll`, `vcruntime140.dll`) need those DLLs zipped next to
  them; the scanner warns about this. Missing DLLs are reported by name in the page instead of a black screen.
- Installers usually work less well than the installed program. Zip the installed folder instead.
- `--wine 11` uses the newer Wine root filesystem (faster for some programs, less tested).
- `--threads` uses the multi-threaded build, which is faster but needs cross-origin isolation.

## flash

- The movie's folder is kept, because SWFs often load sibling files.
- ActionScript 1/2 content is well supported; ActionScript 3 support is broad but not complete (the scanner
  reads the `FileAttributes` tag and warns).

## java

- Runs `Main-Class` from the manifest, or `--main-class`. The Java version (8, 11 or 17) is picked from the
  class-file version of the main class, or set with `--java`.
- Swing and AWT render to a canvas. JavaFX is not supported.
- CheerpJ is free for personal projects, open source and evaluations; commercial use needs a license.

## disk

- ISO images boot from the CD-ROM drive, floppy-sized images from `fda`, and other images from `hda`.
  Images over 64 MB are streamed with HTTP range requests instead of being downloaded up front.
- `--memory` sets guest RAM (defaults: 32 MB for floppies, 128 MB otherwise).
- Saves: the whole machine (RAM, CPU and devices) is the save, so a restored PC resumes exactly where it was.
  Saves are large (roughly the guest's RAM size); the sync server accepts up to 64 MB by default.

## guest

Chosen with `--guest <image>` only, never by the planner. The image must be a raw hard-disk image of an
installed operating system (Windows 95/98/ME, DOS…); the input program and its folder are written into an ISO 9660
image with Joliet long names, which the guest sees as its CD-ROM drive (normally D:).

- `--guest-engine v86` (default) boots the disk as `hda` with the CD on the IDE CD-ROM. Large images are streamed,
  and machine-state saves work as in `disk`.
- `--guest-engine dosboxX` packs disk and CD into a js-dos bundle and boots it in DOSBox-X (`imgmount 2 … -fs none`,
  `imgmount d app.iso -t iso -ide 2m`, `boot -l c`), emulating a Pentium MMX with an S3 card. It suits DirectX and
  3dfx-era games but loads the whole bundle into memory, so it is limited to 1 GB, and progress inside the guest is
  not saved.
- Unpartitioned images get an explicit 63-sector, 16-head geometry; partitioned ones use their MBR.
- You provide the OS image and are responsible for its license.

## linux

- 32-bit x86 only (a CheerpX limit). Static binaries need nothing else. Dynamically linked programs use the
  libraries of a Debian image that CheerpX streams on demand from `disks.webvm.io`. Writes are kept in IndexedDB.
- Terminal programs only: programs that need X11 or Wayland are detected (`DT_NEEDED` on libX11, GTK, Qt, SDL…)
  and get a low score.
- The program runs as user `user` in `~/app`; when it exits, any key restarts it.

## web and electron

- `web` publishes an existing static site unchanged, adding only `waa.json`, header files and notices.
- `electron` extracts the renderer (from `app.asar`, `resources/app` or a nested `resources/app.asar`) and loads
  `waa/electron-shim.js` before the page and its preload script. `require("electron")`, `contextBridge`,
  `ipcRenderer`, `shell` and `clipboard` are replaced by browser stand-ins; IPC calls reject with a readable
  error. Apps that only wrap a website become a redirect to that site.

## stream

The fallback for programs no browser runtime can handle. It writes a Docker project that runs the program
natively (under Wine for Windows programs) and streams its window to the browser with Selkies:

```bash
waa build app64.exe --backend stream --out app64
cd app64 && docker compose up --build   # https://localhost:3001
```

Each viewer uses CPU on the server, and every tab shares one session. Set `CUSTOM_USER`/`PASSWORD` and put it
behind a TLS reverse proxy before you expose it.

### Android

APKs get an Android 14 emulator instead ([docker-android](https://github.com/budtmo/docker-android), pinned to
`emulator_14.0_v3.7.0-p1`) with a noVNC client on port 6080. The scanner reads the binary `AndroidManifest.xml`
(package, version, SDK levels, launcher activity, native ABIs). An `install` service waits for Android to boot,
installs the APK with `adb install -r -g` and starts the launcher activity:

```bash
waa build game.apk --out game && cd game && docker compose up -d   # http://localhost:6080/?autoconnect=true
```

The emulator needs a Linux host with KVM (`/dev/kvm`); macOS and Windows hosts need a Linux VM with nested
virtualisation. Apps with only ARM native code rely on the emulator's ARM translation. The emulator's data
partition is a named volume, so installed apps and their saves survive restarts. Its anonymous usage analytics
are turned off (`USER_BEHAVIOR_ANALYTICS=false`).

## Behaviour checks

`waa record` opens a bundle in a visible Chrome and turns clicks, typing and F2 presses into a scenario.
`waa check` replays it in headless Chrome and compares each snapshot with a baseline PNG (per-channel tolerance 24,
fails when more than 1% of pixels differ, configurable per snapshot); `--update` accepts the current screens.
`waa compare` runs one scenario against two targets and reports a similarity score per snapshot, which is how a
rebuild is measured against its original. All three take bundle folders or URLs and write an HTML report.

## AI rebuild

`waa rebuild <input>` writes a new web app rather than running the old program. The agent loop uses the Claude
API (`@anthropic-ai/sdk`, model `claude-opus-5-5`, adaptive thinking, effort `high`, prompt caching, server-side
fallback) with these tools:

| Tool | What it does |
| --- | --- |
| `list_input_files`, `read_input_file`, `find_strings` | inspect the original: file list, text or hex, ASCII and UTF-16 strings |
| `windows_resources` | decode PE menus, dialogs (every control with class, text, id, position), string tables, version info |
| `screenshot_original` | run the original in its emulator bundle (built automatically, or `--reference`) and return screenshots |
| `write_file`, `copy_input_file`, `read_file`, `list_files` | write the web app; paths are confined to `source/` (no `..`, no symlinks) |
| `screenshot_rebuild` | package the app with the `web` backend, screenshot it, report JavaScript errors and similarity to the original |
| `mcp_<server>_<tool>` | every tool of each `--mcp` stdio server (for example a reverse-engineering server) |
| `finish` | end with a summary |

The output folder holds `source/` (the app), `bundle/` (a publishable bundle), `original/` (the emulated original),
`screens/` (original, rebuild and diff PNGs), `rebuild.json` (turns, tokens, stop reason) and `transcript.json`
(without image data). Tool input is validated locally before anything runs, a tool call cut off by `max_tokens` is
never executed, and refusals stop the run.

## Adding a backend

1. Create `src/backends/<name>.ts` exporting a `Backend` (`assess` and `build`).
2. If it needs a new runtime, add it to `src/runtimes/registry.ts` with pinned hashes, then run
   `npm run test:runtimes`.
3. Register it in `src/backends/index.ts`, add a sample to `scripts/fixtures.mjs`, and add build tests to
   `test/build.test.ts`.
