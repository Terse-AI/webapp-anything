#!/usr/bin/env node
// Regenerates the sample programs in examples/. The generated files are committed so the
// examples work without any toolchain; the Win32 and Java samples are only rebuilt when
// mingw-w64 / a JDK are available.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fx from "./fixtures.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

function write(rel, data) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`wrote examples/${rel} (${data.length} bytes)`);
}

function have(cmd, args = ["--version"]) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

write("hello-dos/HELLO.COM", fx.dosCom());
write("hello-flash/hello.swf", fx.swfMovie());
write("hello-floppy/hello.img", fx.bootFloppy());
write("hello-linux/hello", fx.linuxHello());
write("hello-web/index.html", fx.webIndex);

const win = path.join(root, "hello-win32");
if (have("i686-w64-mingw32-gcc")) {
  execFileSync(
    "i686-w64-mingw32-gcc",
    [
      "-Os",
      "-s",
      "-mwindows",
      "-nostdlib",
      "-e",
      "_WinMainCRTStartup",
      "-o",
      path.join(win, "hello.exe"),
      path.join(win, "hello.c"),
      "-lkernel32",
      "-luser32",
      "-lgdi32",
    ],
    { stdio: "inherit" },
  );
  console.log("built examples/hello-win32/hello.exe");
} else {
  console.log("skipped hello-win32 (install mingw-w64 to rebuild)");
}

const java = path.join(root, "hello-java");
if (have("javac", ["-version"]) && have("jar", ["--version"])) {
  const classes = path.join(java, "classes");
  rmSync(classes, { recursive: true, force: true });
  execFileSync("javac", ["--release", "8", "-d", classes, path.join(java, "src", "hello", "Main.java")], {
    stdio: "inherit",
  });
  execFileSync(
    "jar",
    ["--create", "--file", path.join(java, "hello.jar"), "--main-class", "hello.Main", "-C", classes, "."],
    {
      stdio: "inherit",
    },
  );
  rmSync(classes, { recursive: true, force: true });
  console.log("built examples/hello-java/hello.jar");
} else {
  console.log("skipped hello-java (install a JDK to rebuild)");
}
