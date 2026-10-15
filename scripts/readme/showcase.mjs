#!/usr/bin/env node
// Builds the README showcase from the screenshots made by capture.mjs:
//   .github/assets/screens/<name>.webp   800×600 stills for the gallery
//   .github/assets/showcase.webp         animated tour with captions and crossfades
// Needs rsvg-convert, ffmpeg, cwebp and img2webp on PATH.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    screens: { type: "string", default: ".github/assets/screens-src" },
    out: { type: "string", default: ".github/assets" },
  },
});

const SLIDES = [
  { name: "win32", kind: "Windows program", runtime: "Boxedwine", file: "hello.exe" },
  { name: "dos", kind: "DOS program", runtime: "js-dos", file: "HELLO.COM" },
  { name: "flash", kind: "Flash movie", runtime: "Ruffle", file: "hello.swf" },
  { name: "java", kind: "Java Swing app", runtime: "CheerpJ", file: "hello.jar" },
  { name: "linux", kind: "Linux binary", runtime: "CheerpX", file: "hello" },
  { name: "floppy", kind: "Bootable floppy", runtime: "v86", file: "hello.img" },
];

const W = 960;
const H = 720;
const WIN = { x: 100, y: 96, w: 760, h: 610 };
const SANS = "Helvetica Neue, Helvetica, Arial, sans-serif";
const MONO = "Menlo, Monaco, Consolas, monospace";
const HOLD_MS = 2600;
const FADE_FRAMES = 4;
const FADE_MS = 60;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function frameSvg(slide, png, index) {
  const data = readFileSync(png).toString("base64");
  const contentY = WIN.y + 40;
  const dots = SLIDES.map(
    (_, i) =>
      `<rect x="${W / 2 - SLIDES.length * 11 + i * 22}" y="${H - 6}" width="14" height="3" rx="1.5" fill="${i === index ? "#7aa2ff" : "#2a3247"}"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#07090e"/><stop offset="1" stop-color="#121a2e"/></linearGradient>
  <clipPath id="win"><rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="12"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<circle cx="${WIN.x + 6}" cy="48" r="5" fill="#6ce09a"/>
<text x="${WIN.x + 20}" y="54" font-family="${SANS}" font-size="17" fill="#98a1b3"><tspan font-weight="700" fill="#f0f3fa">${esc(slide.kind)}</tspan>  ·  runs on <tspan fill="#9db8ff" font-weight="700">${esc(slide.runtime)}</tspan></text>
<text x="${WIN.x + WIN.w}" y="54" text-anchor="end" font-family="${MONO}" font-size="13" fill="#6b7489">examples/hello-${slide.name}/${esc(slide.file)}</text>
<g clip-path="url(#win)">
  <rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="40" fill="#171c29"/>
  <circle cx="${WIN.x + 22}" cy="${WIN.y + 20}" r="6" fill="#ff5f57"/><circle cx="${WIN.x + 42}" cy="${WIN.y + 20}" r="6" fill="#febc2e"/><circle cx="${WIN.x + 62}" cy="${WIN.y + 20}" r="6" fill="#28c840"/>
  <rect x="${WIN.x + 86}" y="${WIN.y + 9}" width="${WIN.w - 110}" height="22" rx="11" fill="#0d111b"/>
  <text x="${WIN.x + 104}" y="${WIN.y + 24}" font-family="${MONO}" font-size="12" fill="#9aa4b8">you.github.io/games/hello-${slide.name}/</text>
  <image x="${WIN.x}" y="${contentY}" width="${WIN.w}" height="${WIN.h - 40}" preserveAspectRatio="xMidYMid slice" xlink:href="data:image/png;base64,${data}"/>
</g>
<rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="12" fill="none" stroke="#2a3247"/>
${dots}
</svg>`;
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "waa-showcase-"));
try {
  const stills = path.join(values.out, "screens");
  mkdirSync(stills, { recursive: true });
  // Each slide is a list of composed frames: one still, or a burst (name-1.png…) played twice.
  const slides = SLIDES.map((slide, i) => {
    const png = path.join(values.screens, `${slide.name}.png`);
    run("cwebp", [
      "-quiet",
      "-q",
      "84",
      "-resize",
      "800",
      "600",
      png,
      "-o",
      path.join(stills, `${slide.name}.webp`),
    ]);
    const burst = [];
    for (let k = 1; existsSync(path.join(values.screens, `${slide.name}-${k}.png`)); k++) {
      burst.push(path.join(values.screens, `${slide.name}-${k}.png`));
    }
    return (burst.length ? burst : [png]).map((source, k) => {
      const svg = path.join(tmp, `slide${i}_${k}.svg`);
      writeFileSync(svg, frameSvg(slide, source, i));
      const frame = path.join(tmp, `slide${i}_${k}.png`);
      run("rsvg-convert", ["-w", String(W), "-h", String(H), svg, "-o", frame]);
      return frame;
    });
  });
  const sequence = [];
  slides.forEach((frames, i) => {
    if (frames.length === 1) sequence.push(["-d", String(HOLD_MS), frames[0]]);
    else {
      const each = Math.round(HOLD_MS / (frames.length * 2));
      for (let loop = 0; loop < 2; loop++) for (const f of frames) sequence.push(["-d", String(each), f]);
    }
    const from = frames.at(-1);
    const next = slides[(i + 1) % slides.length][0];
    for (let k = 1; k <= FADE_FRAMES; k++) {
      const a = k / (FADE_FRAMES + 1);
      const blend = path.join(tmp, `fade${i}_${k}.png`);
      run("ffmpeg", [
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        from,
        "-i",
        next,
        "-filter_complex",
        `[0:v][1:v]blend=all_expr='A*(1-${a.toFixed(3)})+B*${a.toFixed(3)}'`,
        "-frames:v",
        "1",
        blend,
      ]);
      sequence.push(["-d", String(FADE_MS), blend]);
    }
  });
  const out = path.join(values.out, "showcase.webp");
  run("img2webp", [
    "-loop",
    "0",
    "-lossy",
    "-q",
    "82",
    "-m",
    "6",
    "-kmax",
    "4",
    ...sequence.flat(),
    "-o",
    out,
  ]);
  const size = readFileSync(out).byteLength;
  console.log(
    `wrote ${out} (${(size / 1024).toFixed(0)} KB, ${sequence.length} frames) and ${SLIDES.length} stills in ${stills}`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
