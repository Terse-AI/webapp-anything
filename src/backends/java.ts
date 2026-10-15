import { runtimeRef } from "../build/bundle.js";
import { CDN } from "../runtimes/registry.js";
import { UserError } from "../util/errors.js";
import { extname } from "../util/paths.js";
import type { Backend, BuildContext, BuildOutput } from "./types.js";

function cheerpjVersion(javaVersion: number | undefined, forced?: 8 | 11 | 17): 8 | 11 | 17 {
  if (forced) return forced;
  if (!javaVersion || javaVersion <= 8) return 8;
  if (javaVersion <= 11) return 11;
  return 17;
}

export const javaBackend: Backend = {
  id: "java",
  title: "Java (CheerpJ)",
  description: "A full Java runtime compiled to WebAssembly; Swing/AWT windows render to a canvas.",
  runs: "Java desktop apps (.jar) built for Java 8, 11 or 17",
  assess(scan) {
    if (scan.kind !== "java-app") return undefined;
    const j = scan.java ?? {};
    const warnings: string[] = [];
    let score = 88;
    if (j.javafx) {
      score = 15;
      warnings.push("JavaFX is not supported.");
    }
    if (j.javaVersion && j.javaVersion > 17) score -= 50;
    if (!j.mainClass) score -= 30;
    if (j.swing === false)
      warnings.push("No Swing/AWT usage found; console-only programs print to the browser console.");
    return {
      backend: "java",
      score: Math.max(score, 5),
      stability: "stable",
      reasons: ["Java bytecode runs unmodified in CheerpJ."],
      warnings: [...warnings, CDN.cheerpj.notice],
    };
  },
  async build(ctx: BuildContext): Promise<BuildOutput> {
    const { scan, tree, out, options } = ctx;
    const spec = CDN.cheerpj;
    let jar: string;
    if (tree.container === "zip" && extname(tree.name) === ".jar") {
      jar = "app/app.jar";
      await out.copyFile(ctx.inputPath, jar);
    } else if (scan.entry && extname(scan.entry) === ".jar") {
      await out.copyTree(tree, "app");
      jar = `app/${scan.entry}`;
    } else if (tree.container === "zip") {
      // A jar without the .jar extension.
      jar = "app/app.jar";
      await out.copyFile(ctx.inputPath, jar);
    } else {
      throw new UserError("No .jar file to run.");
    }
    const mainClass = options.java.mainClass ?? undefined;
    if (!mainClass && !scan.java?.mainClass) {
      throw new UserError("The JAR does not declare a Main-Class.", "Pass --main-class com.example.Main.");
    }
    const data = {
      loader: spec.url,
      jar,
      mainClass: options.java.mainClass ?? null,
      javaVersion: cheerpjVersion(scan.java?.javaVersion, options.java.version),
      args: options.args,
    };
    return {
      type: "static",
      runtimes: [runtimeRef(spec, "cdn", spec.url)],
      requirements: { crossOriginIsolation: false, network: ["cjrtnc.leaningtech.com"] },
      notices: [spec.notice],
      warnings: [spec.notice],
      page: {
        title: options.title,
        autostart: options.autostart,
        head: `<style>#java{width:100%;height:100%}</style>`,
        stage: `<div id="java"></div>`,
        data,
        boot: `
const { data } = WAA.config;
try {
  await WAA.start();
  WAA.status("Loading Java runtime…");
  await WAA.loadScript(data.loader);
  await cheerpjInit({ version: data.javaVersion, status: "none" });
  cheerpjCreateDisplay(-1, -1, document.getElementById("java"));
  WAA.ready();
  // CheerpJ mounts the web server root at /app/.
  const jarPath = "/app" + new URL(data.jar, location.href).pathname;
  const code = data.mainClass
    ? await cheerpjRunMain(data.mainClass, jarPath, ...data.args)
    : await cheerpjRunJar(jarPath, ...data.args);
  console.info("[webapp-anything] Java program exited with code", code);
} catch (err) {
  WAA.fail(err);
}
`,
      },
    };
  },
};
