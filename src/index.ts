// Public library API. The CLI (`waa`) is a thin layer over these functions.
export { BACKENDS, getBackend, type Plan, planFor } from "./backends/index.js";
export type { Assessment, Backend, BuildOptions } from "./backends/types.js";
export { type BuildRequest, type BuildResult, buildApp, defaultTitle } from "./build/build.js";
export { readBundleManifest } from "./build/bundle.js";
export { type BackendId, type BundleManifest, bundleHeaders, MANIFEST_FILE } from "./build/manifest.js";
export { type CheckReport, checkTarget, compareTargets } from "./check/check.js";
export { recordScenario } from "./check/record.js";
export { defaultScenario, parseScenario, type Scenario, type Step } from "./check/scenario.js";
export {
  type PublishOptions,
  type PublishResult,
  type PublishTarget,
  publishBundle,
  zipBundle,
} from "./publish/index.js";
export {
  anthropicClient,
  type ModelClient,
  type RebuildOptions,
  type RebuildResult,
  rebuildApp,
} from "./rebuild/agent.js";
export { McpClient } from "./rebuild/mcp.js";
export { defaultCacheDir, RuntimeCache, type RuntimeProvider } from "./runtimes/cache.js";
export { CDN, VENDORED } from "./runtimes/registry.js";
export { type ScanOptions, type ScanResult, scanInput, scanTree } from "./scan/scan.js";
export { type FileTree, openTree } from "./scan/tree.js";
export type { InputKind, ScanReport } from "./scan/types.js";
export { startPreview } from "./server/preview.js";
export { createHandler, type RunningServer, type ServerOptions, startServer } from "./server/server.js";
export { UserError } from "./util/errors.js";
