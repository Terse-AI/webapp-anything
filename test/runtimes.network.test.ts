// Downloads every pinned runtime from its real source and checks the integrity hashes.
// Opt-in (it fetches ~250 MB): WAA_NETWORK_TESTS=1 npm run test:runtimes
import { describe, expect, it } from "vitest";
import { RuntimeCache } from "../src/runtimes/cache.js";
import { CDN, VENDORED, type VendoredRuntimeId } from "../src/runtimes/registry.js";
import { tempDir } from "./helpers.js";

const enabled = process.env.WAA_NETWORK_TESTS === "1";

describe.skipIf(!enabled)("pinned runtimes", () => {
  for (const id of Object.keys(VENDORED) as VendoredRuntimeId[]) {
    it(`${id} downloads, verifies and installs its layout`, { timeout: 15 * 60_000 }, async () => {
      const cache = new RuntimeCache(await tempDir("waa-cache-"));
      const rt = await cache.ensure(id);
      for (const rule of VENDORED[id].layout) {
        if (typeof rule.from === "string") expect(rt.files).toContain(rule.to);
      }
      expect(await cache.verify(id)).toEqual([]);
    });
  }

  for (const rt of Object.values(CDN)) {
    it(`${rt.id} CDN entry point is reachable`, async () => {
      const res = await fetch(rt.url, { method: "GET" });
      expect(res.ok).toBe(true);
    });
  }
});
