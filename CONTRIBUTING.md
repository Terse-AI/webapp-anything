# Contributing

Thanks for helping. The most useful contributions are **compatibility reports**: which programs work, which do
not, and with which backend options. Please open an issue with the "Compatibility report" template.

## Setup

```bash
npm ci
npm run build
npm test
```

- `npm run lint` runs Biome (formatting and lint); `npm run format` fixes formatting.
- `npm run typecheck` type-checks sources and tests.
- `npm run test:runtimes` downloads every pinned runtime (~250 MB) and verifies its hashes. Run it whenever you
  change `src/runtimes/registry.ts`.
- `npm run examples` regenerates `examples/`. The Win32 and Java samples need mingw-w64 and a JDK.

## Guidelines

- Keep the dependency footprint small (today: `commander` and `fflate`).
- Every new input format needs a fixture in `scripts/fixtures.mjs` and tests. Tests must not use the network.
- Runtime upgrades: change the version and hashes together, run `npm run test:runtimes`, and try the matching
  example in a real browser.
- Do not add sample programs you do not have the right to redistribute. Generate them, as `scripts/fixtures.mjs`
  does.

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Tag `vX.Y.Z` and push the tag. The release workflow publishes to npm (needs the `NPM_TOKEN` secret) and pushes
   the Docker image to `ghcr.io/terse-ai/webapp-anything`.
