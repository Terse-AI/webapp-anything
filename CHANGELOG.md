# Changelog

## 0.2.0 — 2026-10-16

- `waa rebuild`: a Claude agent studies a program (files, strings, hex, Windows menus/dialogs/string tables,
  screenshots of the original running in its emulator, optional MCP tools such as a reverse-engineering server)
  and writes a native web reimplementation, comparing screenshots of its build with the original as it goes.
- Behaviour checks: `waa record` turns what you do in Chrome into a scenario, `waa check` replays it and diffs
  every snapshot against baselines, `waa compare` scores two builds against each other. HTML reports, CI-friendly.
- Saves: DOS programs, Flash SharedObjects and whole PC machine states are saved in the browser, exported and
  imported as `.waasave` files, and synced between devices with a sync code through `waa serve`
  (`/api/saves/<app>`).
- Guest OS backend: `--guest win98.img` boots your own Windows 9x or DOS hard-disk image in v86 or DOSBox-X
  (`--guest-engine dosboxX`) with the program on a generated ISO 9660/Joliet CD-ROM.
- Android: APKs build to a Docker project with a pinned Android 14 emulator and a noVNC web client; the scanner
  reads the binary manifest (package, version, SDK levels, launcher activity, native ABIs).
- Fixed: Linux apps never started (a syntax error in the generated boot script). Every backend's boot script is
  now compiled in the tests.
- Fixed: Windows programs switched the page to real fullscreen on the first click.
- Fixed: a click on the play button before the page finished loading was ignored.
- Fixed: focusing a runtime's canvas could scroll the player toolbar out of view.
- Docs: animated README with real screenshots; generators in `scripts/readme`.

## 0.1.0 — 2026-10-15

First release.

- `waa scan`: identifies DOS (MZ/LE, `.COM`, `.BAT`), Windows (NE/PE, .NET, installers, imports), Linux (ELF), macOS
  (Mach-O), Java (JAR), Flash (SWF), disk images (ISO/El Torito, floppy, MBR), js-dos bundles, Electron apps, web
  apps, Android/iOS packages and scripts, and ranks the programs inside archives and folders.
- `waa build`: backends for js-dos, Boxedwine, Ruffle, CheerpJ, v86, CheerpX, static sites, Electron renderers and
  a Selkies container fallback. Runtimes are pinned and hash-verified; bundles work offline and install as PWAs.
- `waa preview`, and `waa publish` to a webapp-anything server, GitHub Pages or a folder.
- `waa serve`: upload page, HTTP API, content-addressed storage, per-app origins, delete keys, rate limits and a
  Docker image.
