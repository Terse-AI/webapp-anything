import { runtimeRef } from "../build/bundle.js";
import { VENDORED } from "../runtimes/registry.js";
import { UserError } from "../util/errors.js";
import type { Backend, BuildContext, BuildOutput } from "./types.js";

export const flashBackend: Backend = {
  id: "flash",
  title: "Flash (Ruffle)",
  description: "Ruffle, a Flash Player emulator written in Rust and compiled to WebAssembly.",
  runs: "Flash .swf movies and games (ActionScript 1/2, most AS3)",
  assess(scan) {
    if (scan.kind !== "flash-movie") return undefined;
    const as3 = scan.swf?.actionScript3 === true;
    return {
      backend: "flash",
      score: as3 ? 82 : 95,
      stability: "stable",
      reasons: ["Ruffle plays Flash content without the Flash plugin."],
      warnings: as3 ? ["ActionScript 3 support in Ruffle is extensive but not complete."] : [],
    };
  },
  async build(ctx: BuildContext): Promise<BuildOutput> {
    const { scan, tree, out, options } = ctx;
    if (!scan.entry) throw new UserError("No .swf movie to play.");
    // Movies often load sibling files (XML, images, other SWFs), so keep the folder together.
    if (tree.container === "file") await out.copyFromTree(tree, scan.entry, `app/${scan.entry}`);
    else await out.copyTree(tree, "app");

    const spec = VENDORED.ruffle;
    let base: string;
    let delivery: "vendored" | "cdn" = "vendored";
    if (options.runtime === "cdn" && spec.cdn?.base) {
      base = spec.cdn.base;
      delivery = "cdn";
    } else {
      base = await out.addRuntime(await ctx.runtimes.ensure("ruffle"));
    }
    const data = {
      base,
      movie: `app/${scan.entry}`,
      width: scan.swf?.width,
      height: scan.swf?.height,
    };
    return {
      type: "static",
      runtimes: [
        runtimeRef(spec, delivery, base, `https://github.com/ruffle-rs/ruffle/releases/tag/v${spec.version}`),
      ],
      requirements: { crossOriginIsolation: false, network: delivery === "cdn" ? ["cdn.jsdelivr.net"] : [] },
      notices: [],
      warnings: [],
      page: {
        title: options.title,
        autostart: options.autostart,
        head: "<style>#flash{width:100%;height:100%}#flash ruffle-player{width:100%;height:100%}</style>",
        stage: `<div id="flash"></div>`,
        data,
        boot: `
const { data } = WAA.config;
try {
  await WAA.start();
  WAA.status("Loading Flash player…");
  window.RufflePlayer = window.RufflePlayer || {};
  window.RufflePlayer.config = {
    publicPath: new URL(data.base, location.href).href,
    polyfills: false,
    autoplay: "on",
    unmuteOverlay: "hidden",
    splashScreen: false,
    letterbox: "on",
    contextMenu: "rightClickOnly",
    showSwfDownload: false,
    warnOnUnsupportedContent: true,
    allowScriptAccess: false,
  };
  await WAA.loadScript(new URL(data.base + "ruffle.js", location.href).href);
  const player = window.RufflePlayer.newest().createPlayer();
  document.getElementById("flash").appendChild(player);
  player.addEventListener("loadedmetadata", () => WAA.ready());
  WAA.status("Loading movie…");
  await player.ruffle().load({ url: new URL(data.movie, location.href).href });
  WAA.ready();
  player.focus?.();
} catch (err) {
  WAA.fail(err);
}
`,
      },
    };
  },
};
