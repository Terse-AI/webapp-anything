import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import * as fx from "../scripts/fixtures.mjs";
import { dosboxConf } from "../src/backends/dos.js";
import { buildApp } from "../src/build/build.js";
import { readBundleManifest } from "../src/build/bundle.js";
import { readTar } from "../src/formats/tar.js";
import { FakeRuntimes, tempDir, writeFileTemp, writeTree } from "./helpers.js";

let runtimes: FakeRuntimes;
let outRoot: string;

beforeEach(async () => {
  runtimes = new FakeRuntimes(await tempDir("waa-rt-"));
  outRoot = await tempDir("waa-out-");
});

async function build(input: string, extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const outDir = path.join(outRoot, "bundle");
  const result = await buildApp({ input, outDir, ...extra }, { runtimes });
  const html = await readFile(path.join(outDir, "index.html"), "utf8").catch(() => "");
  return { result, outDir, html, read: (rel: string) => readFile(path.join(outDir, ...rel.split("/"))) };
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe("dos backend", () => {
  it("packs a lone .COM into a js-dos bundle with an autoexec", async () => {
    const { result, outDir, html, read } = await build(await writeFileTemp("hello.com", fx.dosCom()));
    expect(result.manifest.backend).toEqual({ id: "dos", stability: "stable" });
    expect(result.manifest.app).toEqual({ title: "Hello", slug: "hello" });
    const bundle = unzipSync(new Uint8Array(await read("app/app.jsdos")));
    expect(Object.keys(bundle).sort()).toEqual([".jsdos/dosbox.conf", "HELLO.COM"]);
    const conf = new TextDecoder().decode(bundle[".jsdos/dosbox.conf"]);
    expect(conf).toContain("mount c .");
    expect(conf.trim().split(/\r\n/).at(-1)).toBe("HELLO.COM");
    expect(html).toContain('href="runtime/js-dos@8.5.0/js-dos.css"');
    expect(html).toContain('"base":"runtime/js-dos@8.5.0/"');
    expect(await exists(path.join(outDir, "runtime/js-dos@8.5.0/emulators/wdosbox.wasm"))).toBe(true);
    // DOSBox-X is only shipped when requested.
    expect(await exists(path.join(outDir, "runtime/js-dos@8.5.0/emulators/wdosbox-x.wasm"))).toBe(false);
    for (const f of [
      "waa.json",
      "sw.js",
      "manifest.webmanifest",
      "_headers",
      "vercel.json",
      "THIRD-PARTY-NOTICES.md",
      "waa/player.js",
    ]) {
      expect(await exists(path.join(outDir, f))).toBe(true);
    }
  });

  it("starts programs in sub-folders and passes arguments", () => {
    const conf = dosboxConf("GAMES/KEEN/KEEN4.EXE", { engine: "dosbox", args: ["/nojoy"] });
    expect(conf).toContain("cd \\GAMES\\KEEN\r\n");
    expect(conf).toContain("KEEN4.EXE /nojoy");
    expect(dosboxConf("RUN.BAT", { engine: "dosbox", args: [] })).toContain("call RUN.BAT");
  });

  it("renames long DOS file names", async () => {
    const { result, read } = await build(await writeFileTemp("my great game.com", fx.dosCom()));
    expect(result.warnings.join(" ")).toMatch(/Renamed/);
    const bundle = unzipSync(new Uint8Array(await read("app/app.jsdos")));
    expect(Object.keys(bundle)).toContain("MYGREATG.COM");
  });

  it("re-roots js-dos bundle folders", async () => {
    const dir = await writeTree({
      "pack/.jsdos/dosbox.conf": "[autoexec]\r\nGAME.EXE\r\n",
      "pack/GAME.EXE": fx.dosExe(),
    });
    const { read } = await build(dir);
    const bundle = unzipSync(new Uint8Array(await read("app/app.jsdos")));
    expect(Object.keys(bundle).sort()).toEqual([".jsdos/dosbox.conf", "GAME.EXE"]);
  });

  it("can load the runtime from a CDN instead", async () => {
    const { html, outDir } = await build(await writeFileTemp("hello.com", fx.dosCom()), { runtime: "cdn" });
    expect(html).toContain("https://cdn.jsdelivr.net/npm/js-dos@8.5.0/dist/");
    expect(await exists(path.join(outDir, "runtime"))).toBe(false);
    expect(runtimes.requested).toEqual([]);
  });
});

describe("windows backend", () => {
  it("mounts the program folder and starts the entry", async () => {
    const dir = await writeTree({ "App/app.exe": fx.peExe(), "App/data.bin": "x" });
    const { result, html, read, outDir } = await build(dir);
    expect(result.manifest.backend.id).toBe("windows");
    expect(Object.keys(unzipSync(new Uint8Array(await read("app/app.zip")))).sort()).toEqual([
      "App/app.exe",
      "App/data.bin",
    ]);
    // Inline JSON escapes "&" so the page cannot be broken out of.
    expect(html).toContain('"params":"app=app\\u0026root=wine6\\u0026p=app.exe\\u0026sound=true"');
    expect(html).toContain('"workingDir":"/home/username/.wine/dosdevices/c:/files/App"');
    expect(await exists(path.join(outDir, "runtime/boxedwine@26R1/st/boxedwine.wasm"))).toBe(true);
    expect(await exists(path.join(outDir, "runtime/boxedwine@26R1/mt/boxedwine.wasm"))).toBe(false);
    expect(await exists(path.join(outDir, "runtime/boxedwine@26R1/fs/wine11.zip"))).toBe(false);
    expect(result.manifest.requirements.crossOriginIsolation).toBe(false);
  });

  it("uses the threaded build and Wine 11 on request", async () => {
    const { result, outDir } = await build(await writeFileTemp("app.exe", fx.peExe()), {
      windows: { threads: true, wine: "11" },
    });
    expect(result.manifest.requirements.crossOriginIsolation).toBe(true);
    expect(await exists(path.join(outDir, "runtime/boxedwine@26R1/mt/boxedwine.wasm"))).toBe(true);
    expect(await exists(path.join(outDir, "runtime/boxedwine@26R1/fs/wine11.zip"))).toBe(true);
    expect(await readFile(path.join(outDir, "_headers"), "utf8")).toContain(
      "Cross-Origin-Embedder-Policy: require-corp",
    );
  });

  it("rejects program names Boxedwine cannot pass through its URL parameters", async () => {
    await expect(build(await writeFileTemp("a&b.exe", fx.peExe()))).rejects.toThrow(/Rename/);
  });
});

describe("other backends", () => {
  it("flash: copies the movie and its folder", async () => {
    const dir = await writeTree({ "movie.swf": fx.swfMovie({ frames: 2 }), "assets/data.xml": "<x/>" });
    const { result, read, html } = await build(dir);
    expect(result.manifest.backend.id).toBe("flash");
    expect((await read("app/assets/data.xml")).toString()).toBe("<x/>");
    expect(html).toContain('"movie":"app/movie.swf"');
  });

  it("java: keeps the jar and loads CheerpJ from its CDN", async () => {
    const { result, html, read } = await build(
      await writeFileTemp("tool.jar", fx.jar({ mainClass: "a.B", major: 61 })),
    );
    expect(result.manifest.backend.id).toBe("java");
    expect(result.manifest.requirements.network).toEqual(["cjrtnc.leaningtech.com"]);
    expect((await read("app/app.jar")).byteLength).toBeGreaterThan(0);
    expect(html).toContain('"javaVersion":17');
    expect(result.manifest.notices.join(" ")).toMatch(/CheerpJ/);
  });

  it("disk: boots floppies from fda with the vendored BIOS", async () => {
    const { result, html, outDir } = await build(await writeFileTemp("boot.img", fx.bootFloppy()));
    expect(result.manifest.backend.id).toBe("disk");
    expect(html).toContain('"slot":"fda"');
    expect(await exists(path.join(outDir, "runtime/v86@0.5.465/bios/seabios.bin"))).toBe(true);
    expect(await exists(path.join(outDir, "app/disk.img"))).toBe(true);
  });

  it("linux: tars the program with an executable bit and requires isolation", async () => {
    const { result, read, html } = await build(await writeFileTemp("hello", fx.linuxHello()));
    expect(result.manifest.backend.id).toBe("linux");
    expect(result.manifest.requirements.crossOriginIsolation).toBe(true);
    const files = readTar(new Uint8Array(await read("app/app.tar")));
    expect(files.map((f) => f.path)).toEqual(["hello"]);
    expect(html).toContain("cxrtnc.leaningtech.com/1.3.9/cx.esm.js");
    expect(html).toContain("exec ./'hello'");
  });

  it("web: publishes the site unchanged", async () => {
    const { result, read, outDir } = await build(
      await writeTree({ "site/index.html": fx.webIndex, "site/app.js": "go()" }),
    );
    expect(result.manifest.backend.id).toBe("web");
    expect((await read("index.html")).toString()).toBe(fx.webIndex);
    expect((await read("app.js")).toString()).toBe("go()");
    expect(await exists(path.join(outDir, "waa/player.js"))).toBe(false);
  });

  it("electron: injects the shim and preload script", async () => {
    const asar = fx.asar({
      "package.json": '{"main":"main.js"}',
      "main.js": "win.loadFile('ui/index.html'); preload: path.join(__dirname, 'preload.js')",
      "ui/index.html": "<html><head><title>x</title></head><body></body></html>",
      "preload.js": "1",
      "native.node": "binary",
    });
    const { result, read, outDir } = await build(await writeFileTemp("app.asar", asar));
    expect(result.manifest.backend.id).toBe("electron");
    const page = (await read("ui/index.html")).toString();
    expect(page).toContain(
      '<head><script src="../waa/electron-shim.js"></script><script src="../preload.js"></script>',
    );
    expect((await read("index.html")).toString()).toContain("url=ui/index.html");
    expect(await exists(path.join(outDir, "native.node"))).toBe(false);
  });

  it("stream: writes a Docker project for 64-bit programs", async () => {
    const { result, read, outDir } = await build(
      await writeFileTemp("app64.exe", fx.peExe({ machine: 0x8664 })),
    );
    expect(result.manifest.type).toBe("container");
    expect(result.manifest.backend.id).toBe("stream");
    const dockerfile = (await read("Dockerfile")).toString();
    expect(dockerfile).toContain("FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie");
    expect(dockerfile).toContain("wine32:i386");
    expect((await read("root/defaults/autostart")).toString()).toContain("exec wine '/app/app64.exe'");
    expect((await read("compose.yaml")).toString()).toContain("platform: linux/amd64");
    expect(await exists(path.join(outDir, "index.html"))).toBe(false);
  });
});

describe("bundles", () => {
  it("writes a valid manifest and escapes the title", async () => {
    const { result, outDir, html } = await build(await writeFileTemp("x.com", fx.dosCom()), {
      title: '</script><b>"Hi"',
    });
    const manifest = await readBundleManifest(outDir);
    expect(manifest).toEqual(result.manifest);
    expect(manifest.source).toMatchObject({ name: "x.com", kind: "dos-program", entry: "x.com" });
    expect(html).toContain("<title>&lt;/script&gt;&lt;b&gt;&quot;Hi&quot;</title>");
    expect(html).not.toContain('</script><b>"Hi"');
  });

  it("refuses to clobber unrelated folders but rebuilds its own", async () => {
    const outDir = path.join(outRoot, "bundle");
    const input = await writeFileTemp("x.com", fx.dosCom());
    await buildApp({ input, outDir }, { runtimes });
    await buildApp({ input, outDir }, { runtimes });
    const other = await writeFileTemp("y.com", fx.dosCom());
    await expect(buildApp({ input: other, outDir }, { runtimes })).rejects.toThrow(/holds a bundle of x.com/);
    await buildApp({ input: other, outDir, force: true }, { runtimes });

    const unrelated = await tempDir();
    await writeFile(path.join(unrelated, "important.txt"), "keep me");
    await expect(buildApp({ input, outDir: unrelated }, { runtimes })).rejects.toThrow(/not empty/);
    expect(await readdir(unrelated)).toEqual(["important.txt"]);
  });

  it("fails clearly for inputs nothing can run", async () => {
    await expect(build(await writeFileTemp("app.apk", fx.apk()))).rejects.toThrow(/Android/);
    await expect(build(await writeFileTemp("x.zip", zipSync({ "a.txt": strToU8("a") })))).rejects.toThrow();
  });
});
