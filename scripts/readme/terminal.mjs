// Generates the animated terminal demo (.github/assets/terminal.svg) from the CLI's real output.
// Each command is "typed" by sliding a mask off it; output lines fade in on a shared timeline.
// Without animation support the SVG shows the finished session.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github",
  "assets",
  "terminal.svg",
);

const C = {
  bg: "#0d1117",
  bar: "#161b22",
  line: "#30363d",
  text: "#c9d1d9",
  dim: "#7d8590",
  bold: "#f0f6fc",
  prompt: "#3fb950",
  accent: "#79c0ff",
  warn: "#d29922",
  good: "#3fb950",
};

// [kind, segments]; segments are [text, color, bold?]. "cmd" lines are typed.
const SESSION = [
  ["cmd", "npx webapp-anything scan hello.exe"],
  [
    "out",
    [
      ["Input    ", C.bold, true],
      ["hello.exe ", C.text],
      ["(4.0 KB, file, 1 file)", C.dim],
    ],
  ],
  [
    "out",
    [
      ["Found    ", C.bold, true],
      ["Windows program (32-bit x86, gui): hello.exe", C.text],
    ],
  ],
  [
    "out",
    [
      ["Runs on  ", C.bold, true],
      ["windows — Windows (Boxedwine) ", C.text],
      ["score 80, experimental", C.dim],
    ],
  ],
  ["out", [["         32-bit Windows programs run under Wine in the browser.", C.dim]]],
  ["gap"],
  ["cmd", "npx webapp-anything build hello.exe"],
  ["out", [["Downloading Boxedwine 26R1 (one-time, cached)…", C.dim]]],
  [
    "out",
    [
      ["Built    ", C.bold, true],
      ["Hello → out/hello", C.text],
    ],
  ],
  [
    "out",
    [
      ["Runs on  ", C.bold, true],
      ["Windows (Boxedwine) ", C.text],
      ["(experimental)", C.dim],
    ],
  ],
  [
    "out",
    [
      ["Size     ", C.bold, true],
      ["38 MB in 17 files", C.text],
    ],
  ],
  ["gap"],
  ["cmd", "npx webapp-anything publish out/hello --to github-pages --repo you/games"],
  [
    "out",
    [
      ["Published ", C.bold, true],
      ["https://you.github.io/games/hello/", C.accent],
    ],
  ],
  ["out", [["  Created the gh-pages branch. Enable GitHub Pages for it under Settings → Pages.", C.dim]]],
];

const CYCLE = 18;
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const SIZE = 13;
const CHAR = 7.85;
const LINE = 21;
const PAD_X = 22;
const TOP = 58;
const WIDTH = 920;
const HEIGHT = TOP + SESSION.length * LINE + 26;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (t) => `${((t / CYCLE) * 100).toFixed(2)}%`;

let t = 0.6;
const styles = [];
const rows = [];
SESSION.forEach((entry, i) => {
  const y = TOP + i * LINE;
  const [kind, payload] = entry;
  if (kind === "gap") {
    t += 0.5;
    return;
  }
  const show = t;
  styles.push(
    `@keyframes l${i} { 0%, ${pct(show - 0.01)} { opacity: 0 } ${pct(show)}, 96% { opacity: 1 } 99%, 100% { opacity: 0 } }`,
    `.l${i} { animation: l${i} ${CYCLE}s infinite both; }`,
  );
  if (kind === "cmd") {
    const cmd = payload;
    const dur = Math.min(2.2, 0.035 * cmd.length + 0.4);
    const x0 = PAD_X + 2 * CHAR;
    const width = cmd.length * CHAR;
    styles.push(
      `@keyframes m${i} { 0%, ${pct(show + 0.25)} { transform: translateX(0) } ${pct(show + 0.25 + dur)} { transform: translateX(${width.toFixed(1)}px) } ${pct(show + 0.26 + dur)}, 100% { transform: translateX(2000px) } }`,
      `.m${i} { transform: translateX(2000px); animation: m${i} ${CYCLE}s infinite both; animation-timing-function: steps(${cmd.length}, end); }`,
    );
    rows.push(`<g class="l${i}">
  <text x="${PAD_X}" y="${y}" font-family="${FONT}" font-size="${SIZE}" fill="${C.prompt}" font-weight="700">❯</text>
  <text x="${x0}" y="${y}" font-family="${FONT}" font-size="${SIZE}" fill="${C.bold}">${esc(cmd)}</text>
  <g class="m${i}"><rect x="${x0 - 1}" y="${y - 15}" width="${(width + 12).toFixed(1)}" height="20" fill="${C.bg}"/><rect class="cur" x="${x0}" y="${y - 13}" width="8" height="16" fill="${C.text}"/></g>
</g>`);
    t = show + 0.25 + dur + 0.55;
  } else {
    const spans = payload
      .map(
        ([text, color, bold]) =>
          `<tspan fill="${color}"${bold ? ' font-weight="700"' : ""}>${esc(text)}</tspan>`,
      )
      .join("");
    rows.push(
      `<text class="l${i}" x="${PAD_X}" y="${y}" font-family="${FONT}" font-size="${SIZE}" xml:space="preserve">${spans}</text>`,
    );
    t = show + 0.12;
    const next = SESSION[i + 1];
    if (next?.[0] !== "out") t += 0.7;
  }
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="t">
<title id="t">Terminal: scan, build and publish a Windows program with webapp-anything</title>
<style>
${styles.join("\n")}
.cur { animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0 } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="12" fill="${C.bg}" stroke="${C.line}"/>
<path d="M12.5 0.5 H${WIDTH - 12.5} A12 12 0 0 1 ${WIDTH - 0.5} 12.5 V34 H0.5 V12.5 A12 12 0 0 1 12.5 0.5 Z" fill="${C.bar}"/>
<line x1="0.5" y1="34" x2="${WIDTH - 0.5}" y2="34" stroke="${C.line}"/>
<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>
<text x="${WIDTH / 2}" y="22" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${C.dim}">~/games — zsh</text>
${rows.join("\n")}
</svg>
`;

writeFileSync(out, svg);
console.log(
  `wrote ${path.relative(process.cwd(), out)} (${svg.length} bytes, ${t.toFixed(1)}s of ${CYCLE}s used)`,
);
