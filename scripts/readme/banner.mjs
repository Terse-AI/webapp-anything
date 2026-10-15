// Generates the animated README hero banner (.github/assets/banner-{dark,light}.svg).
// Pure SVG + CSS keyframes (no SMIL, no scripts, no web fonts), so GitHub renders it as an image.
// The browser window cycles through the six sample programs in examples/.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "assets");

const THEMES = {
  dark: {
    bg1: "#07090e",
    bg2: "#101626",
    grid: "#ffffff",
    gridOpacity: 0.045,
    title1: "#ffffff",
    title2: "#9db8ff",
    text: "#aab3c5",
    pill: "#121826",
    pillLine: "#273047",
    chip: "#121826",
    chipLine: "#273047",
    chipText: "#c7cfdd",
    chrome: "#171c29",
    chromeLine: "#2a3247",
    url: "#0d111b",
    urlText: "#9aa4b8",
    glow: "#3d63dd",
    shadow: 0.55,
  },
  light: {
    bg1: "#f7f8fc",
    bg2: "#e9eefb",
    grid: "#1b2a4a",
    gridOpacity: 0.06,
    title1: "#0d1424",
    title2: "#3d63dd",
    text: "#4b5568",
    pill: "#ffffff",
    pillLine: "#d5dbe8",
    chip: "#ffffff",
    chipLine: "#d5dbe8",
    chipText: "#334058",
    chrome: "#ffffff",
    chromeLine: "#d5dbe8",
    url: "#f0f3f9",
    urlText: "#5d6880",
    glow: "#7aa2ff",
    shadow: 0.18,
  },
};

const SCENES = [
  { chip: "DOS .COM", slug: "hello-dos", accent: "#9ca3af" },
  { chip: "Win32 .EXE", slug: "hello-win32", accent: "#7aa2ff" },
  { chip: "Flash .SWF", slug: "hello-flash", accent: "#f0a35e" },
  { chip: "Java .JAR", slug: "hello-java", accent: "#f87171" },
  { chip: "Linux ELF", slug: "hello-linux", accent: "#6ce09a" },
  { chip: "Disk .IMG", slug: "hello-floppy", accent: "#c4b5fd" },
];

const CYCLE = 15; // seconds for the whole loop
const SLOT = CYCLE / SCENES.length;
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

// Browser window geometry.
const W = { x: 716, y: 58, w: 500, h: 326 };
const SCREEN = { x: W.x, y: W.y + 40, w: W.w, h: W.h - 40 };

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scene(i, body) {
  return `<g class="scene" style="animation-delay:${(i * SLOT).toFixed(2)}s"${i === 0 ? ' data-first="1"' : ""}>${body}</g>`;
}

function screens() {
  const { x, y, w, h } = SCREEN;
  const mono = (tx, ty, text, fill = "#d7dde8", size = 13) =>
    `<text x="${tx}" y="${ty}" font-family="${MONO}" font-size="${size}" fill="${fill}">${esc(text)}</text>`;
  const dos = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>
${mono(x + 18, y + 34, "C:\\> HELLO.COM", "#bfbfbf")}
${mono(x + 18, y + 58, "Hello from webapp-anything!", "#bfbfbf")}
${mono(x + 18, y + 78, "This DOS program is running in your browser.", "#bfbfbf")}
${mono(x + 18, y + 110, "Press any key to exit.", "#bfbfbf")}
<rect class="cursor" x="${x + 18}" y="${y + 120}" width="9" height="3" fill="#bfbfbf"/>`;

  const winX = x + 80;
  const winY = y + 70;
  const win = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#3f6fa3"/>
<rect x="${winX}" y="${winY}" width="340" height="150" fill="#f0f0f0" stroke="#5a6f8f"/>
<rect x="${winX}" y="${winY}" width="340" height="22" fill="#2a64c5"/>
<text x="${winX + 8}" y="${winY + 15}" font-family="${SANS}" font-size="12" fill="#fff">Hello (Win32)</text>
<g fill="#e8e8e8" stroke="#555"><rect x="${winX + 300}" y="${winY + 5}" width="12" height="12"/><rect x="${winX + 318}" y="${winY + 5}" width="12" height="12"/></g>
<text x="${winX + 170}" y="${winY + 60}" text-anchor="middle" font-family="${SANS}" font-size="13" font-weight="700" fill="#111">Hello from webapp-anything!</text>
<text x="${winX + 170}" y="${winY + 80}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="#111">This Windows program runs in your browser.</text>
<rect x="${winX + 120}" y="${winY + 104}" width="100" height="28" fill="#e9e9e9" stroke="#333"/>
<text x="${winX + 170}" y="${winY + 122}" text-anchor="middle" font-family="${SANS}" font-size="12" font-weight="700" fill="#111">Click me</text>
<path class="pointer" d="M${winX + 196} ${winY + 116} l0 16 l4 -4 l3 7 l3 -1 l-3 -7 l6 0 z" fill="#fff" stroke="#000" stroke-width="1"/>`;

  const cx = x + w / 2;
  const cy = y + h / 2;
  const flash = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#151924"/>
<g transform="translate(${cx} ${cy})"><g class="spin"><rect x="-58" y="-58" width="116" height="116" fill="#7aa2ff"/></g></g>
<g transform="translate(${cx} ${cy})"><g class="orbit"><g transform="translate(118 0)"><rect x="-26" y="-26" width="52" height="52" fill="#f0a35e"/></g></g></g>
<g transform="translate(${cx} ${cy})"><g class="orbit2"><g transform="translate(-86 0)"><g class="spin-rev"><rect x="-20" y="-20" width="40" height="40" fill="#6ce09a"/></g></g></g></g>`;

  const jx = x + 70;
  const jy = y + 64;
  const java = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>
<rect x="${jx}" y="${jy}" width="360" height="160" fill="#eeeeee"/>
<rect x="${jx}" y="${jy}" width="360" height="20" fill="#6d96cf"/>
<text x="${jx + 6}" y="${jy + 14}" font-family="${SANS}" font-size="12" fill="#fff">Hello (Java Swing)</text>
<text x="${jx + 180}" y="${jy + 74}" text-anchor="middle" font-family="${SANS}" font-size="15" fill="#333">Hello from webapp-anything!</text>
<text x="${jx + 180}" y="${jy + 96}" text-anchor="middle" font-family="${SANS}" font-size="15" fill="#333">Button clicked <tspan class="count">3</tspan> times.</text>
<rect x="${jx}" y="${jy + 136}" width="360" height="24" fill="#dfe8f2" stroke="#9fb4cc"/>
<text x="${jx + 180}" y="${jy + 152}" text-anchor="middle" font-family="${SANS}" font-size="12" font-weight="700" fill="#222">Click me</text>
<text x="${x + w / 2}" y="${y + h - 10}" text-anchor="middle" font-family="${SANS}" font-size="9" fill="#888">CheerpJ</text>`;

  const linux = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>
${mono(x + 14, y + 28, "~/app$ ./hello", "#6ce09a")}
${mono(x + 14, y + 50, "What's your name? Ada Lovelace")}
${mono(x + 14, y + 70, "Hello, Ada Lovelace")}
${mono(x + 14, y + 90, "Greetings from a Linux binary running in your browser.", "#d7dde8", 12)}
${mono(x + 14, y + 122, "[exited with status 0]", "#6b7280", 12)}
<rect class="cursor" x="${x + 14}" y="${y + 132}" width="8" height="15" fill="#d7dde8"/>`;

  const disk = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>
${mono(x + 40, y + 70, "SeaBIOS (version rel-1.16.2)", "#c9c9c9")}
${mono(x + 40, y + 90, "Booting from Floppy...", "#c9c9c9")}
${mono(x + 40, y + 110, "Hello from webapp-anything!", "#c9c9c9")}
${mono(x + 40, y + 130, "This PC booted from a floppy image.", "#c9c9c9")}
<rect class="cursor" x="${x + 40}" y="${y + 138}" width="9" height="3" fill="#c9c9c9"/>`;

  return [dos, win, flash, java, linux, disk].map((b, i) => scene(i, b)).join("\n");
}

function render(name) {
  const t = THEMES[name];
  const chips = SCENES.map((s, i) => {
    const cx = 64 + (i % 3) * 186;
    const cy = 286 + Math.floor(i / 3) * 46;
    return `<g class="chip" style="animation-delay:${(i * SLOT).toFixed(2)}s">
  <rect x="${cx}" y="${cy}" width="172" height="34" rx="17" fill="${t.chip}" stroke="${t.chipLine}"/>
  <rect class="chip-on"${i === 0 ? ' data-first="1"' : ""} x="${cx}" y="${cy}" width="172" height="34" rx="17" fill="none" stroke="${s.accent}" stroke-width="2"/>
  <circle cx="${cx + 20}" cy="${cy + 17}" r="5" fill="${s.accent}"/>
  <text x="${cx + 34}" y="${cy + 22}" font-family="${MONO}" font-size="13" fill="${t.chipText}">${esc(s.chip)}</text>
</g>`;
  }).join("\n");

  const slugs = SCENES.map(
    (s, i) =>
      `<text class="scene" style="animation-delay:${(i * SLOT).toFixed(2)}s"${i === 0 ? ' data-first="1"' : ""} x="${W.x + 110}" y="${W.y + 25}" font-family="${MONO}" font-size="12" fill="${t.urlText}">you.github.io/games/${s.slug}/</text>`,
  ).join("\n");

  const command = "$ npx webapp-anything build game.zip";
  const cmdX = 64;
  const cmdY = 200;
  const charW = 8.45;
  const cmdW = command.length * charW + 48;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="420" viewBox="0 0 1280 420" role="img" aria-labelledby="t d">
<title id="t">webapp-anything</title>
<desc id="d">Turn desktop software into web apps: DOS, Windows, Flash, Java, Linux and disk images running in a browser window.</desc>
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/></linearGradient>
  <linearGradient id="title" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.title1}"/><stop offset="1" stop-color="${t.title2}"/></linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${t.glow}" stop-opacity="0.45"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>
  <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="${t.grid}" stroke-opacity="${t.gridOpacity}"/></pattern>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="${t.shadow}"/></filter>
  <clipPath id="screen"><rect x="${SCREEN.x}" y="${SCREEN.y}" width="${SCREEN.w}" height="${SCREEN.h}" rx="0"/></clipPath>
  <clipPath id="pill"><rect x="${cmdX}" y="${cmdY}" width="${cmdW.toFixed(0)}" height="44" rx="10"/></clipPath>
  <clipPath id="window"><rect x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" rx="14"/></clipPath>
</defs>
<style>
  .scene { opacity: 0; animation: scene ${CYCLE}s infinite both; }
  .scene[data-first] { opacity: 1; }
  @keyframes scene { 0% { opacity: 0 } 1.6% { opacity: 1 } 15% { opacity: 1 } 16.6% { opacity: 0 } 100% { opacity: 0 } }
  .chip-on { opacity: 0; animation: chip ${CYCLE}s infinite both; animation-delay: inherit; }
  .chip-on[data-first] { opacity: 1; }
  .chip { animation: lift ${CYCLE}s infinite both; }
  @keyframes chip { 0% { opacity: 0 } 1.6% { opacity: 1 } 15% { opacity: 1 } 16.6% { opacity: 0 } 100% { opacity: 0 } }
  @keyframes lift { 0% { transform: translateY(0) } 1.6% { transform: translateY(-3px) } 15% { transform: translateY(-3px) } 16.6% { transform: translateY(0) } 100% { transform: translateY(0) } }
  .cursor { animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0 } }
  .spin { animation: spin 6s linear infinite; }
  .spin-rev { animation: spin 4s linear infinite reverse; }
  .orbit { animation: spin 7s linear infinite; }
  .orbit2 { animation: spin 5s linear infinite reverse; }
  @keyframes spin { to { transform: rotate(360deg) } }
  .pointer { animation: press 2.5s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
  @keyframes press { 0%, 60%, 100% { transform: translate(0, 0) } 70% { transform: translate(-2px, -2px) } }
  .typing { transform: translateX(${(command.length * charW).toFixed(1)}px); animation: type ${CYCLE}s steps(${command.length}) infinite; }
  @keyframes type { 0% { transform: translateX(0) } 18% { transform: translateX(${(command.length * charW).toFixed(1)}px) } 100% { transform: translateX(${(command.length * charW).toFixed(1)}px) } }
  .flow { stroke-dasharray: 6 10; animation: flow 1.2s linear infinite; }
  @keyframes flow { to { stroke-dashoffset: -32 } }
  .float { animation: float 6s ease-in-out infinite; }
  @keyframes float { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before { animation: none !important; }
    .scene[data-first], .chip-on[data-first] { opacity: 1; }
  }
</style>
<rect width="1280" height="420" fill="url(#bg)"/>
<rect width="1280" height="420" fill="url(#grid)"/>
<ellipse cx="${W.x + W.w / 2}" cy="${W.y + W.h / 2 + 20}" rx="420" ry="230" fill="url(#glow)"/>

<text x="64" y="118" font-family="${SANS}" font-size="62" font-weight="800" letter-spacing="-1.5" fill="url(#title)">webapp-anything</text>
<text x="66" y="158" font-family="${SANS}" font-size="22" fill="${t.text}">Any desktop program → a link that runs in the browser.</text>

<g>
  <rect x="${cmdX}" y="${cmdY}" width="${cmdW.toFixed(0)}" height="44" rx="10" fill="${t.pill}" stroke="${t.pillLine}"/>
  <text x="${cmdX + 18}" y="${cmdY + 28}" font-family="${MONO}" font-size="14" fill="${t.chipText}">${esc(command)}</text>
  <g clip-path="url(#pill)"><g class="typing"><rect x="${cmdX + 18}" y="${cmdY + 10}" width="${(command.length * charW + 8).toFixed(1)}" height="26" fill="${t.pill}"/><rect class="cursor" x="${cmdX + 21}" y="${cmdY + 13}" width="8" height="19" fill="${t.title2}"/></g></g>
</g>

${chips}

<path class="flow" d="M 622 304 C 660 304, 670 230, ${W.x - 8} 230" fill="none" stroke="${t.title2}" stroke-width="2" stroke-linecap="round" opacity="0.7"/>
<circle cx="${W.x - 8}" cy="230" r="4" fill="${t.title2}"/>

<g class="float">
  <g filter="url(#shadow)"><rect x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" rx="14" fill="${t.chrome}" stroke="${t.chromeLine}"/></g>
  <g clip-path="url(#window)">
    <rect x="${W.x}" y="${W.y}" width="${W.w}" height="40" fill="${t.chrome}"/>
    <circle cx="${W.x + 22}" cy="${W.y + 20}" r="6" fill="#ff5f57"/><circle cx="${W.x + 42}" cy="${W.y + 20}" r="6" fill="#febc2e"/><circle cx="${W.x + 62}" cy="${W.y + 20}" r="6" fill="#28c840"/>
    <rect x="${W.x + 84}" y="${W.y + 9}" width="${W.w - 104}" height="22" rx="11" fill="${t.url}"/>
    <path d="M${W.x + 95} ${W.y + 22} v-5 a3 3 0 0 1 6 0 v5 z M${W.x + 94} ${W.y + 19} h8 v6 h-8 z" fill="${t.urlText}" opacity="0.8"/>
    ${slugs}
    <g clip-path="url(#screen)">
${screens()}
    </g>
  </g>
  <rect x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" rx="14" fill="none" stroke="${t.chromeLine}"/>
</g>
</svg>
`;
}

for (const name of Object.keys(THEMES)) {
  const file = path.join(out, `banner-${name}.svg`);
  writeFileSync(file, render(name));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
