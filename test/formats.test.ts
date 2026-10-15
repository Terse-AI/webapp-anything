import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as fx from "../scripts/fixtures.mjs";
import { looksLikeAsar, readAsar } from "../src/formats/asar.js";
import { parseElf, parseExecutable, parseMachO, parseMz } from "../src/formats/executables.js";
import { classFileJavaVersion, parseManifest } from "../src/formats/java.js";
import { parseDiskImage, parseSwf } from "../src/formats/media.js";
import { readTar, writeTar } from "../src/formats/tar.js";
import { readZipDirectory, readZipEntry, readZipEntryHead } from "../src/formats/zip.js";
import { bufferSource, crc32 } from "../src/util/bytes.js";

describe("zip", () => {
  const archive = zipSync({
    "game/GAME.EXE": new Uint8Array(5000).fill(7),
    "game/readme.txt": strToU8("hello ".repeat(500)),
    "empty/": new Uint8Array(0),
  });

  it("lists the central directory", async () => {
    const entries = await readZipDirectory(bufferSource(archive));
    const files = entries.filter((e) => !e.isDirectory).map((e) => [e.path, e.size]);
    expect(files).toEqual([
      ["game/GAME.EXE", 5000],
      ["game/readme.txt", 3000],
    ]);
  });

  it("reads and verifies entries, including partial heads", async () => {
    const src = bufferSource(archive);
    const entries = await readZipDirectory(src);
    const readme = entries.find((e) => e.path === "game/readme.txt")!;
    expect(new TextDecoder().decode(await readZipEntry(src, readme))).toBe("hello ".repeat(500));
    expect(new TextDecoder().decode(await readZipEntryHead(src, readme, 11))).toBe("hello hello");
  });

  it("detects corruption", async () => {
    const copy = archive.slice();
    const entries = await readZipDirectory(bufferSource(copy));
    const exe = entries.find((e) => e.path === "game/GAME.EXE")!;
    // Flip the stored CRC in the central directory record so data and checksum disagree.
    (exe as { crc32: number }).crc32 ^= 1;
    await expect(readZipEntry(bufferSource(copy), exe)).rejects.toThrow(/CRC/);
  });

  it("flags entries that try to escape the archive", async () => {
    const evil = zipSync({ "../../etc/passwd": strToU8("x"), "ok.txt": strToU8("y") });
    const entries = await readZipDirectory(bufferSource(evil));
    expect(entries.find((e) => e.rawName === "../../etc/passwd")?.path).toBeNull();
    expect(entries.find((e) => e.rawName === "ok.txt")?.path).toBe("ok.txt");
  });

  it("rejects non-zip data", async () => {
    await expect(readZipDirectory(bufferSource(new Uint8Array(100)))).rejects.toThrow(/Not a zip/);
  });
});

describe("tar", () => {
  it("round-trips files, modes and long names", () => {
    const long = `${"deep/".repeat(30)}file.txt`;
    const tar = writeTar([
      { path: "a.txt", data: strToU8("alpha") },
      { path: long, data: strToU8("beta"), mode: 0o755 },
    ]);
    const files = readTar(tar);
    expect(files.map((f) => f.path)).toEqual(["a.txt", long]);
    expect(new TextDecoder().decode(files[1]!.data)).toBe("beta");
  });
});

describe("executables", () => {
  it("parses a 32-bit GUI PE with imports", () => {
    const info = parseMz(fx.peExe({ imports: ["kernel32.dll", "user32.dll", "ddraw.dll"] }));
    expect(info).toMatchObject({
      format: "pe",
      arch: "x86",
      bits: 32,
      subsystem: "gui",
      dll: false,
      dotnet: false,
    });
    expect(info && info.format === "pe" && info.imports).toEqual(["kernel32.dll", "user32.dll", "ddraw.dll"]);
  });

  it("parses 64-bit, console, DLL and .NET variants", () => {
    expect(parseMz(fx.peExe({ machine: 0x8664 }))).toMatchObject({ arch: "x86_64", bits: 64 });
    expect(parseMz(fx.peExe({ subsystem: 3 }))).toMatchObject({ subsystem: "console" });
    expect(parseMz(fx.peExe({ dll: true }))).toMatchObject({ dll: true });
    expect(parseMz(fx.peExe({ dotnet: true }))).toMatchObject({ dotnet: true });
    expect(parseMz(fx.peExe({ marker: "Inno Setup Setup Data" }))).toMatchObject({ installer: "inno" });
  });

  it("parses DOS, NE and LE headers", () => {
    expect(parseMz(fx.dosExe())).toEqual({ format: "dos", extended: false, extender: undefined });
    expect(parseMz(fx.dosExe({ extender: true }))).toMatchObject({
      format: "dos",
      extended: true,
      extender: "DOS/4GW",
    });
    expect(parseMz(fx.neExe())).toEqual({ format: "ne", targetOs: "windows" });
    expect(parseMz(fx.neExe({ os: 1 }))).toEqual({ format: "ne", targetOs: "os2" });
    expect(parseMz(fx.leExe())).toMatchObject({ format: "le", extender: "DOS/4GW" });
  });

  it("parses static and dynamic ELF binaries", () => {
    expect(parseElf(fx.linuxHello())).toMatchObject({
      arch: "x86",
      bits: 32,
      type: "exec",
      staticallyLinked: true,
      gui: false,
    });
    const dyn = parseElf(fx.elfDynamic({ needed: ["libX11.so.6", "libc.so.6"] }));
    expect(dyn).toMatchObject({
      arch: "x86_64",
      bits: 64,
      interpreter: "/lib64/ld-linux-x86-64.so.2",
      staticallyLinked: false,
      gui: true,
    });
    expect(dyn?.needed).toEqual(["libX11.so.6", "libc.so.6"]);
    expect(parseElf(fx.elfDynamic({ bits: 32, machine: 3, interp: "/lib/ld-linux.so.2" }))).toMatchObject({
      arch: "x86",
      bits: 32,
    });
  });

  it("tells Mach-O fat binaries from Java class files", () => {
    expect(parseMachO(fx.machO())).toEqual({ format: "macho", arches: ["arm64"], fat: false });
    expect(parseMachO(fx.machO({ fat: true }))).toEqual({
      format: "macho",
      arches: ["x86_64", "arm64"],
      fat: true,
    });
    expect(parseMachO(fx.classFile(52))).toBeUndefined();
    expect(parseExecutable(new Uint8Array(64))).toBeUndefined();
  });
});

describe("java", () => {
  it("reads manifests with continuation lines", () => {
    const mf = parseManifest(
      "Manifest-Version: 1.0\r\nMain-Class: com.example.really.long.packa\r\n ge.Main\r\nClass-Path: a.jar b.jar\r\n\r\nName: other\r\nX: y\r\n",
    );
    expect(mf["Main-Class"]).toBe("com.example.really.long.package.Main");
    expect(mf["Class-Path"]).toBe("a.jar b.jar");
    expect(mf.X).toBeUndefined();
  });
  it("maps class versions to Java releases", () => {
    expect(classFileJavaVersion(fx.classFile(52))).toBe(8);
    expect(classFileJavaVersion(fx.classFile(55))).toBe(11);
    expect(classFileJavaVersion(fx.classFile(61))).toBe(17);
    expect(classFileJavaVersion(new Uint8Array(8))).toBeUndefined();
  });
});

describe("media", () => {
  it("parses SWF headers", () => {
    const swf = parseSwf(fx.swfMovie({ frames: 10 }));
    expect(swf).toMatchObject({
      compression: "none",
      version: 10,
      width: 550,
      height: 400,
      frameRate: 24,
      frameCount: 10,
      actionScript3: false,
    });
  });
  it("identifies ISO, floppy and hard-disk images", () => {
    expect(parseDiskImage(fx.isoImage(), 40960, ".iso")).toEqual({
      type: "iso",
      bootable: true,
      label: "TESTDISC",
    });
    expect(parseDiskImage(fx.isoImage({ bootable: false }), 40960, ".iso")).toMatchObject({
      bootable: false,
    });
    const floppy = fx.bootFloppy();
    expect(parseDiskImage(floppy.subarray(0, 72 * 1024), floppy.length, ".img")).toEqual({
      type: "floppy",
      bootable: true,
    });
    const mbr = new Uint8Array(1024);
    mbr[510] = 0x55;
    mbr[511] = 0xaa;
    expect(parseDiskImage(mbr, 64 * 1024 * 1024, ".img")).toEqual({ type: "hdd", bootable: true });
    expect(parseDiskImage(new Uint8Array(1024), 1024, ".txt")).toBeUndefined();
  });
});

describe("asar", () => {
  it("lists files and their offsets", async () => {
    const data = fx.asar({ "package.json": '{"main":"main.js"}', "src/index.html": "<h1>hi</h1>" });
    expect(looksLikeAsar(data)).toBe(true);
    const src = bufferSource(data);
    const files = await readAsar(src);
    expect(files.map((f) => f.path)).toEqual(["package.json", "src/index.html"]);
    const html = files[1]!;
    expect(new TextDecoder().decode(await src.read(html.offset, html.size))).toBe("<h1>hi</h1>");
  });
});

describe("crc32", () => {
  it("matches the reference value", () => {
    expect(crc32(strToU8("123456789"))).toBe(0xcbf43926);
  });
});
