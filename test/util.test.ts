import { describe, expect, it } from "vitest";
import { escapeHtml, inlineJson } from "../src/build/html.js";
import { formatBytes } from "../src/util/bytes.js";
import { isValidSlug, resolveInside, safeRelativePath, slugify } from "../src/util/paths.js";

describe("paths", () => {
  it("normalises safe relative paths", () => {
    expect(safeRelativePath("a/b/./c.txt")).toBe("a/b/c.txt");
    expect(safeRelativePath("a\\b\\c.txt")).toBe("a/b/c.txt");
    expect(safeRelativePath("a//b/")).toBe("a/b");
  });
  it("rejects paths that escape", () => {
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/Windows", "c:\\x", "a\0b", "", "."]) {
      expect(safeRelativePath(bad)).toBeNull();
    }
    expect(() => resolveInside("/tmp/root", "../x")).toThrow();
  });
  it("builds URL slugs", () => {
    expect(slugify("Commander Keen 4.exe")).toBe("commander-keen-4");
    expect(slugify("Café — Déjà Vu!")).toBe("cafe-deja-vu");
    expect(slugify("***")).toBe("app");
    expect(slugify("x".repeat(100)).length).toBe(63);
    expect(isValidSlug("ok-name")).toBe(true);
    expect(isValidSlug("-bad")).toBe(false);
    expect(isValidSlug("Bad")).toBe(false);
  });
});

describe("html", () => {
  it("escapes markup and inline JSON", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const json = inlineJson({ s: "</script><script>alert(1)</script>\u2028" });
    expect(json).not.toContain("</script>");
    expect(JSON.parse(json)).toEqual({ s: "</script><script>alert(1)</script>\u2028" });
  });
});

describe("formatBytes", () => {
  it("is human readable", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(40 * 1024 * 1024)).toBe("40 MB");
  });
});
