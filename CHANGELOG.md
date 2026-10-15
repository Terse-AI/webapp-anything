# Changelog

## Unreleased

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
