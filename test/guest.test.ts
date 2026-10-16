import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as fx from "../scripts/fixtures.mjs";
import { guestDosboxConf, inspectGuestImage } from "../src/backends/guest.js";
import { Browser } from "../src/browser/cdp.js";
import { findChrome } from "../src/browser/chrome.js";
import { buildApp } from "../src/build/build.js";
import { decodePng } from "../src/check/png.js";
import { resolveTarget } from "../src/check/runner.js";
import { readIso } from "../src/formats/iso.js";
import { RuntimeCache } from "../src/runtimes/cache.js";
import { FakeRuntimes, tempDir, writeFileTemp, writeTree } from "./helpers.js";

const program = () => writeTree({ "SETUP.EXE": fx.peExe(), "Data Files/level one.dat": "LEVEL1" });

describe("guest images", () => {
  it("reads the disk geometry", async () => {
    const info = await inspectGuestImage(await writeFileTemp("win98.img", fx.bootDisk()));
    expect(info).toEqual({ size: 8_257_536, partitioned: false });
    const conf = guestDosboxConf(info, 64);
    expect(conf).toContain("imgmount 2 guest.img -t hdd -fs none -size 512,63,16,16\r\n");
    expect(conf).toContain("imgmount d app.iso -t iso -ide 2m\r\n");
    expect(conf).toContain("boot -l c\r\n");
    expect(conf).toContain("memsize=64\r\n");
  });

  it("leaves partitioned disks to the MBR", async () => {
    const disk = fx.bootDisk();
    disk.set([0x80, 1, 1, 0, 0x0c, 15, 63, 15, 63, 0, 0, 0, 0xc1, 0x3e, 0, 0], 446);
    const info = await inspectGuestImage(await writeFileTemp("win98.img", disk));
    expect(info.partitioned).toBe(true);
    expect(guestDosboxConf(info, 64)).toContain("imgmount 2 guest.img -t hdd -fs none\r\n");
  });

  it("rejects floppies and CDs", async () => {
    await expect(inspectGuestImage(await writeFileTemp("a.img", fx.bootFloppy()))).rejects.toThrow(
      /not a hard-disk image/,
    );
    await expect(inspectGuestImage(await writeFileTemp("a.iso", fx.isoImage()))).rejects.toThrow(
      /not a hard-disk image/,
    );
    await expect(inspectGuestImage("/nonexistent/win98.img")).rejects.toThrow(/not found/);
  });

  it("builds a v86 bundle with the program on a CD", async () => {
    const out = path.join(await tempDir(), "app");
    const guest = await writeFileTemp("win98.img", fx.bootDisk());
    const result = await buildApp(
      { input: await program(), outDir: out, guest },
      { runtimes: new FakeRuntimes(await tempDir()) },
    );
    expect(result.manifest.backend.id).toBe("guest");
    expect((await readFile(path.join(out, "app/guest.img"))).length).toBe(8_257_536);
    const files = readIso(new Uint8Array(await readFile(path.join(out, "app/app.iso"))));
    const names = files.map((f) => f.path).sort();
    expect(names).toEqual(["Data Files/level one.dat", "SETUP.EXE"]);
    expect(new TextDecoder().decode(files.find((f) => f.path.endsWith(".dat"))!.data)).toBe("LEVEL1");
    const page = await readFile(path.join(out, "index.html"), "utf8");
    expect(page).toContain('"cdrom":"app/app.iso"');
    expect(page).toContain('"slot":"hda"');
  });

  it("builds a DOSBox-X bundle", async () => {
    const out = path.join(await tempDir(), "app");
    const guest = await writeFileTemp("win98.img", fx.bootDisk());
    const result = await buildApp(
      { input: await program(), outDir: out, guest, guestEngine: "dosboxX" },
      { runtimes: new FakeRuntimes(await tempDir()) },
    );
    expect(result.manifest.backend.id).toBe("guest");
    const bundle = unzipSync(new Uint8Array(await readFile(path.join(out, "app/guest.jsdos"))));
    expect(Object.keys(bundle).sort()).toEqual([".jsdos/dosbox.conf", "app.iso", "guest.img"]);
    expect(new TextDecoder().decode(bundle[".jsdos/dosbox.conf"])).toContain("boot -l c");
    const page = await readFile(path.join(out, "index.html"), "utf8");
    expect(page).toContain('"engine":"dosboxX"');
    expect(page).toContain('"saves":false');
  });
});

const chrome = findChrome();
const runBrowser = !!chrome && process.env.WAA_SKIP_BROWSER_TESTS !== "1";

describe.skipIf(!runBrowser)("guest images in Chrome", () => {
  async function boot(url: string) {
    const browser = await Browser.launch();
    const page = await browser.newPage({ width: 800, height: 600 });
    await page.goto(url);
    const [x, y] = await page.evaluate<[number, number]>(
      `(() => { const r = document.getElementById("waa-play").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
    );
    await page.click(x, y);
    await page.waitFor(`document.getElementById("waa-overlay").dataset.state === "ready"`, 120_000);
    return { browser, page };
  }

  it("boots the guest disk in v86 with the CD attached", { timeout: 300_000 }, async () => {
    const out = path.join(await tempDir(), "v86");
    await buildApp(
      {
        input: await program(),
        outDir: out,
        guest: await writeFileTemp("guest.img", fx.bootDisk("GUEST OS BOOTED FROM HDA")),
      },
      { runtimes: new RuntimeCache(process.env.WAA_CACHE_DIR) },
    );
    const { url, server } = await resolveTarget(out);
    const { browser, page } = await boot(url);
    try {
      await page.waitFor(
        `document.getElementById("screen_container").textContent.includes("GUEST OS BOOTED FROM HDA")`,
        60_000,
      );
      expect(
        await page.evaluate<boolean>(
          `performance.getEntriesByType("resource").some((e) => e.name.endsWith("/app/app.iso"))`,
        ),
      ).toBe(true);
    } finally {
      await browser.close();
      server?.close();
    }
  });

  it("boots the guest disk in DOSBox-X", { timeout: 300_000 }, async () => {
    const out = path.join(await tempDir(), "dosboxx");
    await buildApp(
      {
        input: await program(),
        outDir: out,
        guest: await writeFileTemp("guest.img", fx.bootDisk("", { fill: 5 })),
        guestEngine: "dosboxX",
      },
      { runtimes: new RuntimeCache(process.env.WAA_CACHE_DIR) },
    );
    const { url, server } = await resolveTarget(out);
    const { browser, page } = await boot(url);
    try {
      // The boot sector paints the whole screen magenta (VGA palette 5) once it runs. Count magenta pixels
      // over the whole page, so a js-dos overlay or a moved canvas cannot hide it.
      const end = Date.now() + 180_000;
      let share = 0;
      let shot: Uint8Array = new Uint8Array();
      while (Date.now() < end) {
        shot = await page.screenshot();
        const img = decodePng(shot);
        let magenta = 0;
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i]! > 140 && img.data[i + 1]! < 40 && img.data[i + 2]! > 140) magenta++;
        }
        share = magenta / (img.width * img.height);
        if (share > 0.2) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      if (share <= 0.2) {
        const dump = path.join(os.tmpdir(), `waa-dosboxx-${Date.now()}.png`);
        await writeFile(dump, shot);
        expect.fail(
          `DOSBox-X never painted the guest's screen (${(share * 100).toFixed(1)}% magenta); see ${dump}`,
        );
      }
    } finally {
      await browser.close();
      server?.close();
    }
  });
});
