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
| `stream` | Selkies base image (`ghcr.io/linuxserver/baseimage-selkies:debiantrixie`) | Docker | – | Docker project |

## dos

- Single programs are renamed to an 8.3 name when needed. Archives keep their layout. The generated
  `.jsdos/dosbox.conf` mounts the bundle as `C:`, changes into the program's folder and starts it (`call` for
  `.bat` files). `--cycles` sets DOSBox CPU speed; `--arg` adds command-line arguments.
- Existing js-dos bundles (`.jsdos`, or any zip/folder with `.jsdos/dosbox.conf`) are used as they are.
- DOS/4GW, DOS/32A, PMODE/W and DJGPP extenders are detected and run normally.

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

## Adding a backend

1. Create `src/backends/<name>.ts` exporting a `Backend` (`assess` and `build`).
2. If it needs a new runtime, add it to `src/runtimes/registry.ts` with pinned hashes, then run
   `npm run test:runtimes`.
3. Register it in `src/backends/index.ts`, add a sample to `scripts/fixtures.mjs`, and add build tests to
   `test/build.test.ts`.
