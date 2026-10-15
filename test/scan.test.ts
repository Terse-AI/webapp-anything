import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as fx from "../scripts/fixtures.mjs";
import { planFor } from "../src/backends/index.js";
import { scanInput } from "../src/scan/scan.js";
import { writeFileTemp, writeTree } from "./helpers.js";

async function scan(file: string, entry?: string) {
  const { report, tree } = await scanInput(file, { entry });
  await tree.close();
  return report;
}

describe("single files", () => {
  it.each([
    ["HELLO.COM", fx.dosCom(), "dos-program", "dos"],
    ["GAME.EXE", fx.dosExe({ extender: true }), "dos-program", "dos"],
    ["hello.exe", fx.peExe(), "windows-program", "windows"],
    ["old.exe", fx.neExe(), "windows-program", "windows"],
    ["movie.swf", fx.swfMovie({ frames: 2 }), "flash-movie", "flash"],
    ["boot.img", fx.bootFloppy(), "disk-image", "disk"],
    ["disc.iso", fx.isoImage(), "disk-image", "disk"],
    ["hello", fx.linuxHello(), "linux-program", "linux"],
    ["page.html", fx.webIndex, "web-app", "web"],
  ])("%s → %s on %s", async (name, data, kind, backend) => {
    const report = await scan(await writeFileTemp(name, data));
    expect(report.kind).toBe(kind);
    expect(report.entry).toBe(name);
    expect(report.input.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(planFor(report).chosen?.backend).toBe(backend);
  });

  it("recognises scripts, wasm and Mach-O", async () => {
    expect((await scan(await writeFileTemp("run.py", "#!/usr/bin/env python3\nprint(1)\n"))).script).toEqual({
      interpreter: "python3",
    });
    expect(
      (await scan(await writeFileTemp("m.wasm", new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])))).kind,
    ).toBe("wasm-module");
    const mac = await scan(await writeFileTemp("App", fx.machO()));
    expect(mac.kind).toBe("macos-program");
    expect(planFor(mac).unsupported).toMatch(/macOS/);
  });

  it("warns about installers, 3D APIs and the Universal CRT", async () => {
    const setup = await scan(
      await writeFileTemp("setup.exe", fx.peExe({ marker: "Nullsoft Install System" })),
    );
    expect(setup.warnings.join(" ")).toMatch(/installer/);
    const gl = await scan(
      await writeFileTemp("game.exe", fx.peExe({ imports: ["kernel32.dll", "opengl32.dll"] })),
    );
    expect(gl.warnings.join(" ")).toMatch(/3D acceleration/);
    const ucrt = await scan(
      await writeFileTemp(
        "app.exe",
        fx.peExe({ imports: ["kernel32.dll", "api-ms-win-crt-runtime-l1-1-0.dll"] }),
      ),
    );
    expect(ucrt.warnings.join(" ")).toMatch(/Universal C Runtime/);
  });

  it("does not offer Boxedwine for 64-bit programs", async () => {
    const report = await scan(await writeFileTemp("app64.exe", fx.peExe({ machine: 0x8664 })));
    const plan = planFor(report);
    expect(plan.chosen?.backend).toBe("stream");
    expect(plan.candidates.find((c) => c.backend === "windows")?.score).toBe(0);
  });

  it("marks unknown files as unsupported", async () => {
    const report = await scan(await writeFileTemp("notes.txt", "just text"));
    expect(report.kind).toBe("unknown");
    expect(planFor(report).chosen).toBeUndefined();
  });
});

describe("archives and folders", () => {
  it("picks the main program and skips setup utilities", async () => {
    const zip = zipSync({
      "KEEN/KEEN.EXE": fx.dosExe(),
      "KEEN/SETUP.EXE": fx.dosExe(),
      "KEEN/DATA.DAT": new Uint8Array(100),
    });
    const report = await scan(await writeFileTemp("keen.zip", zip));
    expect(report.kind).toBe("dos-program");
    expect(report.entry).toBe("KEEN/KEEN.EXE");
    expect(report.programs.map((p) => p.path)).toContain("KEEN/SETUP.EXE");
  });

  it("honours an explicit entry", async () => {
    const zip = zipSync({ "A.EXE": fx.dosExe(), "B.EXE": fx.dosExe() });
    const report = await scan(await writeFileTemp("two.zip", zip), "B.EXE");
    expect(report.entry).toBe("B.EXE");
    await expect(scan(await writeFileTemp("two.zip", zip), "C.EXE")).rejects.toThrow(/not in the input/);
  });

  it("detects Windows programs inside folders", async () => {
    const dir = await writeTree({
      "bin/app.exe": fx.peExe(),
      "bin/helper.dll": fx.peExe({ dll: true }),
      "readme.txt": "x",
    });
    const report = await scan(dir);
    expect(report.input.container).toBe("dir");
    expect(report.entry).toBe("bin/app.exe");
    expect(report.kind).toBe("windows-program");
  });

  it("detects jars, APKs, js-dos bundles and web apps", async () => {
    const jar = await scan(await writeFileTemp("app.jar", fx.jar({ mainClass: "com.acme.Main", major: 55 })));
    expect(jar.kind).toBe("java-app");
    expect(jar.java).toMatchObject({ mainClass: "com.acme.Main", javaVersion: 11, swing: true });
    expect(planFor(jar).chosen?.backend).toBe("java");

    const apk = await scan(await writeFileTemp("app.apk", fx.apk()));
    expect(apk.kind).toBe("android-app");
    expect(planFor(apk).unsupported).toMatch(/Android/);

    const bundle = await scan(
      await writeFileTemp(
        "game.jsdos",
        zipSync({ ".jsdos/dosbox.conf": strToU8("[autoexec]\n"), "GAME.EXE": fx.dosExe() }),
      ),
    );
    expect(bundle.kind).toBe("jsdos-bundle");
    expect(planFor(bundle).chosen?.backend).toBe("dos");

    const site = await scan(await writeTree({ "site/index.html": fx.webIndex, "site/app.js": "1" }));
    expect(site.kind).toBe("web-app");
    expect(site.web?.index).toBe("site/index.html");
  });

  it("finds a jar inside an archive", async () => {
    const zip = zipSync({
      "MyApp/myapp.jar": fx.jar({ mainClass: "my.App" }),
      "MyApp/lib/dep.jar": fx.jar({ mainClass: "dep.X" }),
    });
    const report = await scan(await writeFileTemp("MyApp.zip", zip));
    expect(report.kind).toBe("java-app");
    expect(report.entry).toBe("MyApp/myapp.jar");
    expect(report.java?.mainClass).toBe("my.App");
  });

  it("reads Electron apps from asar archives", async () => {
    const asar = fx.asar({
      "package.json": '{"name":"notes","main":"main.js"}',
      "main.js":
        "win.loadFile('index.html'); new BrowserWindow({webPreferences:{preload: path.join(__dirname, 'preload.js')}})",
      "index.html": "<html><head></head><body>notes</body></html>",
      "preload.js": "require('electron').contextBridge.exposeInMainWorld('api', {})",
    });
    const report = await scan(await writeFileTemp("app.asar", asar));
    expect(report.kind).toBe("electron-app");
    expect(report.electron).toMatchObject({ page: "index.html", main: "main.js", usesNodeInRenderer: false });
    expect(planFor(report).chosen?.backend).toBe("electron");
  });

  it("finds Linux binaries without extensions", async () => {
    const report = await scan(await writeTree({ "tool/run": fx.linuxHello(), "tool/README": "x" }));
    expect(report.kind).toBe("linux-program");
    expect(report.entry).toBe("tool/run");
  });

  it("explains when an archive has nothing runnable", async () => {
    const report = await scan(await writeFileTemp("docs.zip", zipSync({ "a.txt": strToU8("a") })));
    expect(report.kind).toBe("unknown");
    expect(report.summary).toMatch(/No runnable program/);
  });
});
