// Generates the animated "how it works" diagram (.github/assets/pipeline-{dark,light}.svg).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "assets");
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const THEMES = {
  dark: {
    bg: "#0d1117",
    card: "#161b22",
    line: "#30363d",
    title: "#f0f6fc",
    text: "#8b949e",
    accent: "#79c0ff",
    glow: "#1f6feb",
  },
  light: {
    bg: "#ffffff",
    card: "#f6f8fa",
    line: "#d0d7de",
    title: "#1f2328",
    text: "#59636e",
    accent: "#0969da",
    glow: "#54aeff",
  },
};

const STAGES = [
  { title: "Scan", lines: ["PE · NE · ELF · Mach-O", "SWF · JAR · ISO · asar"], icon: "scan" },
  { title: "Plan", lines: ["9 backends score it,", "the best one wins"], icon: "plan" },
  { title: "Build", lines: ["static bundle with a", "pinned, verified runtime"], icon: "build" },
  { title: "Publish", lines: ["waa serve · GitHub Pages", "Netlify · Vercel · any host"], icon: "publish" },
];

const CYCLE = 8;
const W = 1200;
const H = 250;
const CARD_W = 236;
const CARD_H = 170;
const GAP = (W - 80 - CARD_W * 4) / 3;

function icon(kind, x, y, c) {
  switch (kind) {
    case "scan":
      return `<g fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round"><circle cx="${x + 14}" cy="${y + 14}" r="10"/><path d="M${x + 22} ${y + 22} l9 9"/></g>
<rect class="scanline" x="${x + 5}" y="${y + 6}" width="18" height="2" fill="${c}"/>`;
    case "plan":
      return [10, 18, 26]
        .map(
          (h, i) =>
            `<rect class="bar b${i}" x="${x + 2 + i * 11}" y="${y + 32 - h}" width="8" height="${h}" rx="2" fill="${c}"/>`,
        )
        .join("");
    case "build":
      return `<g fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round"><path d="M${x + 16} ${y + 2} l14 7 v16 l-14 7 l-14 -7 v-16 z"/><path d="M${x + 2} ${y + 9} l14 7 l14 -7 M${x + 16} ${y + 16} v16"/></g>`;
    default:
      return `<g fill="none" stroke="${c}" stroke-width="2.5"><circle cx="${x + 16}" cy="${y + 16}" r="14"/><ellipse cx="${x + 16}" cy="${y + 16}" rx="6" ry="14"/><path d="M${x + 2} ${y + 16} h28"/></g>`;
  }
}

function render(name) {
  const t = THEMES[name];
  const slot = CYCLE / STAGES.length;
  const cards = STAGES.map((s, i) => {
    const x = 40 + i * (CARD_W + GAP);
    const y = 40;
    return `<g class="card" style="animation-delay:${(i * slot).toFixed(2)}s">
  <rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="16" fill="${t.card}" stroke="${t.line}"/>
  <rect class="ring" x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="16" fill="none" stroke="${t.accent}" stroke-width="2"/>
  <text x="${x + CARD_W - 20}" y="${y + 34}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${t.text}">0${i + 1}</text>
  ${icon(s.icon, x + 22, y + 22, t.accent)}
  <text x="${x + 22}" y="${y + 92}" font-family="${SANS}" font-size="22" font-weight="700" fill="${t.title}">${s.title}</text>
  <text x="${x + 22}" y="${y + 120}" font-family="${SANS}" font-size="14" fill="${t.text}">${s.lines[0]}</text>
  <text x="${x + 22}" y="${y + 140}" font-family="${SANS}" font-size="14" fill="${t.text}">${s.lines[1]}</text>
</g>`;
  }).join("\n");
  const links = [0, 1, 2]
    .map((i) => {
      const x1 = 40 + i * (CARD_W + GAP) + CARD_W + 6;
      const x2 = x1 + GAP - 12;
      const y = 40 + CARD_H / 2;
      return `<line class="flow" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${t.accent}" stroke-width="2" stroke-linecap="round"/>
<path d="M${x2 - 6} ${y - 5} l6 5 l-6 5" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round"/>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t">
<title id="t">How it works: scan, plan, build, publish</title>
<style>
  .ring { opacity: 0; animation: ring ${CYCLE}s infinite both; animation-delay: inherit; }
  .card { animation: none; }
  .card:first-of-type .ring { opacity: 1; }
  @keyframes ring { 0% { opacity: 0 } 4% { opacity: 1 } 24% { opacity: 1 } 28% { opacity: 0 } 100% { opacity: 0 } }
  .flow { stroke-dasharray: 4 8; animation: flow 0.9s linear infinite; }
  @keyframes flow { to { stroke-dashoffset: -24 } }
  .bar { transform-box: fill-box; transform-origin: bottom; animation: grow 2.4s ease-in-out infinite; }
  .b1 { animation-delay: 0.2s; } .b2 { animation-delay: 0.4s; }
  @keyframes grow { 0%, 100% { transform: scaleY(0.45) } 50% { transform: scaleY(1) } }
  .scanline { animation: scan 2s ease-in-out infinite; }
  @keyframes scan { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(14px) } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
<rect width="${W}" height="${H}" fill="${t.bg}"/>
${links}
${cards}
</svg>
`;
}

for (const name of Object.keys(THEMES)) {
  const file = path.join(out, `pipeline-${name}.svg`);
  writeFileSync(file, render(name));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
