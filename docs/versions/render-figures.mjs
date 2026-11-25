// Render the version-report figures from data/v1-v2.json.
// Static SVG, no dependencies. Run: node docs/versions/render-figures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(here, 'data/v1-v2.json'), 'utf8'));
const outDir = path.join(here, 'assets');
fs.mkdirSync(outDir, { recursive: true });

const C = {
  surface: '#fcfcfb',
  border: '#e6e5e0',
  grid: '#e9e8e3',
  text: '#0b0b0b',
  secondary: '#52514e',
  muted: '#8a887f',
  kimi: '#eb6834',
  deepseek: '#2a78d6',
  v2alt: '#1baf7a',
  neutral: '#a8a69f',
};
const FONT = "'Inter','ui-sans-serif','-apple-system','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function frame(width, height, title, desc) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="${C.surface}" stroke="${C.border}"/>
<style>
text { font-family: ${FONT}; }
.t { font-size: 15px; font-weight: 600; fill: ${C.text}; }
.s { font-size: 12px; fill: ${C.secondary}; }
.a { font-size: 11px; fill: ${C.secondary}; font-variant-numeric: tabular-nums; }
.v { font-size: 11px; font-weight: 600; fill: ${C.text}; font-variant-numeric: tabular-nums; }
.l { font-size: 12px; fill: ${C.secondary}; }
</style>`;
}

function legend(y, items) {
  let x = 32;
  const parts = [];
  for (const [color, label] of items) {
    parts.push(`<rect x="${x}" y="${y - 8}" width="10" height="10" rx="2" fill="${color}"/>`);
    parts.push(`<text class="l" x="${x + 16}" y="${y + 1}">${esc(label)}</text>`);
    x += 16 + label.length * 6.6 + 22;
  }
  return parts.join('\n');
}

function grid(x0, x1, y0, yTop, ticks, max, format = v => String(v)) {
  const parts = [];
  for (const tick of ticks) {
    const y = y0 - (tick / max) * (y0 - yTop);
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`);
    parts.push(`<text class="a" x="${x0 - 10}" y="${y + 4}" text-anchor="end">${format(tick)}</text>`);
  }
  return parts.join('\n');
}

function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function hbarPath(x, y, w, h) {
  const r = Math.min(4, w, h / 2);
  return `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
}

// ---------------------------------------------------------------- Figure 1
function figureShare() {
  const W = 880, H = 380;
  const groups = [
    { label: 'Share of requests', values: [data.before.requestShare, data.at(20).requestShare, data.at(40).requestShare] },
    { label: 'Share of tokens', values: [data.before.tokenShare, data.at(20).tokenShare, data.at(40).tokenShare] },
  ];
  const series = [
    { name: 'v1', color: C.kimi },
    { name: 'v2 · threshold 20', color: C.deepseek },
    { name: 'v2 · threshold 40', color: C.v2alt },
  ];
  const x0 = 76, x1 = 828, y0 = 292, yTop = 110, yMax = 100;
  const groupGap = 120, barW = 46, barGap = 2;
  const groupW = series.length * barW + (series.length - 1) * barGap;
  const totalW = groups.length * groupW + (groups.length - 1) * groupGap;
  const startX = x0 + ((x1 - x0) - totalW) / 2;
  const parts = [frame(W, H, 'Kimi share of the task, v1 vs v2',
    'Grouped columns: share of the 63 requests and of all tokens served by Kimi on the same real task.')];
  parts.push(`<text class="t" x="32" y="32">Kimi share of the task, before and after</text>`);
  parts.push(`<text class="s" x="32" y="52">63 real requests · NTL/CASMI submission task · 2026-11-25</text>`);
  parts.push(legend(76, series.map(s => [s.color, s.name])));
  parts.push(grid(x0, x1, y0, yTop, [0, 25, 50, 75, 100], yMax, v => `${v}%`));
  groups.forEach((group, gi) => {
    const gx = startX + gi * (groupW + groupGap);
    series.forEach((s, si) => {
      const value = group.values[si];
      const h = (value / yMax) * (y0 - yTop);
      const x = gx + si * (barW + barGap);
      parts.push(`<path d="${barPath(x, y0 - h, barW, h)}" fill="${s.color}"/>`);
      parts.push(`<text class="v" x="${x + barW / 2}" y="${y0 - h - 8}" text-anchor="middle">${value}%</text>`);
    });
    parts.push(`<text class="a" x="${gx + groupW / 2}" y="${y0 + 22}" text-anchor="middle">${esc(group.label)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('\n');
}

// ---------------------------------------------------------------- Figure 2
function figureCounter() {
  const W = 880, H = 380;
  const rowsV1 = data.before.rows;
  const rowsV2 = data.at(20).rows;
  const t0 = Date.parse(rowsV1[0].at);
  const elapsed = r => (Date.parse(r.at) - t0) / 60000;
  const maxT = elapsed(rowsV1.at(-1));
  const x0 = 76, x1 = 800, y0 = 296, yTop = 110, yMax = 90;
  const xOf = t => x0 + (t / maxT) * (x1 - x0);
  const yOf = v => y0 - (v / yMax) * (y0 - yTop);
  const line = rows => rows.map((r, i) => `${i ? 'L' : 'M'}${xOf(elapsed(r)).toFixed(1)},${yOf(r.mutatingCalls).toFixed(1)}`).join(' ');
  const firstCross = rows => rows.find(r => r.mutatingCalls >= 20);

  const parts = [frame(W, H, 'Cumulative “mutating” tool calls on the same task',
    'Cumulative mutating-tool-call counter for v1 and v2 over the same 63 requests. The threshold line at 20 is the escalation rule.')];
  parts.push(`<text class="t" x="32" y="32">The counter that escalated the task</text>`);
  parts.push(`<text class="s" x="32" y="52">Cumulative “mutating” tool calls · same 63 requests · rule at 20</text>`);
  parts.push(legend(76, [[C.kimi, `v1 · ends at ${rowsV1.at(-1).mutatingCalls}`], [C.deepseek, `v2 · ends at ${rowsV2.at(-1).mutatingCalls}`]]));
  parts.push(grid(x0, x1, y0, yTop, [0, 20, 40, 60, 80], yMax));

  // threshold rule
  parts.push(`<line x1="${x0}" y1="${yOf(20)}" x2="${x1}" y2="${yOf(20)}" stroke="${C.muted}" stroke-width="1"/>`);
  parts.push(`<text class="a" x="${x1 + 6}" y="${yOf(20) + 4}">20</text>`);

  // x ticks every 10 minutes
  for (let m = 0; m <= Math.floor(maxT / 10) * 10; m += 10) {
    const x = xOf(m);
    const stamp = new Date(t0 + m * 60000).toISOString().slice(11, 16);
    parts.push(`<text class="a" x="${x}" y="${y0 + 20}" text-anchor="middle">${stamp}</text>`);
  }

  parts.push(`<path d="${line(rowsV1)}" fill="none" stroke="${C.kimi}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
  parts.push(`<path d="${line(rowsV2)}" fill="none" stroke="${C.deepseek}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);

  for (const [rows, color, label] of [[rowsV1, C.kimi, 'v1'], [rowsV2, C.deepseek, 'v2']]) {
    const hit = firstCross(rows);
    const x = xOf(elapsed(hit)), y = yOf(hit.mutatingCalls);
    parts.push(`<circle cx="${x}" cy="${y}" r="4.5" fill="${color}" stroke="${C.surface}" stroke-width="2"/>`);
    parts.push(`<text class="v" x="${x + 8}" y="${y - 8}">${label} crosses at ${hit.at.slice(11, 16)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// ---------------------------------------------------------------- Figure 3
function figureTimeline() {
  const W = 880, H = 250;
  const v1 = data.before.rows;
  const v2 = data.at(20).rows;
  const n = v1.length;
  const x0 = 92, x1 = 828;
  const cell = (x1 - x0) / n;
  const gap = 2;
  const rows = [
    { label: 'v1', data: v1, y: 92 },
    { label: 'v2', data: v2, y: 132 },
  ];
  const parts = [frame(W, H, 'Per-request provider timeline',
    'One cell per request for v1 and v2; orange is Kimi, blue is DeepSeek.')];
  parts.push(`<text class="t" x="32" y="32">Who served each request</text>`);
  parts.push(`<text class="s" x="32" y="52">63 requests, left to right · one cell = one request</text>`);
  parts.push(legend(74, [[C.kimi, 'Kimi'], [C.deepseek, 'DeepSeek']]));
  for (const row of rows) {
    parts.push(`<text class="a" x="${x0 - 12}" y="${row.y + 9}" text-anchor="end">${row.label}</text>`);
    row.data.forEach((r, i) => {
      const color = r.provider === 'kimi' ? C.kimi : C.deepseek;
      parts.push(`<rect x="${(x0 + i * cell).toFixed(1)}" y="${row.y}" width="${(cell - gap).toFixed(1)}" height="14" rx="2" fill="${color}"/>`);
    });
  }
  const t0 = Date.parse(v1[0].at);
  [10, 20, 30, 40].forEach(minute => {
    const target = t0 + minute * 60000;
    const index = v1.findIndex(r => Date.parse(r.at) >= target);
    if (index < 0) return;
    const x = x0 + index * cell;
    parts.push(`<line x1="${x}" y1="160" x2="${x}" y2="166" stroke="${C.muted}" stroke-width="1"/>`);
    parts.push(`<text class="a" x="${x}" y="182" text-anchor="middle">${new Date(target).toISOString().slice(11, 16)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('\n');
}

// ---------------------------------------------------------------- Figure 4
function figureCommands() {
  const W = 880, H = 320;
  const stats = data.commandStats;
  const rows = [];
  for (const s of stats) {
    const name = s.id === 'submission-task' ? 'Submission task' : 'Read-only analysis';
    rows.push({ label: `${name} · v1`, mutating: s.v1.mutating, read: s.v1.read, total: s.calls });
    rows.push({ label: `${name} · v2`, mutating: s.v2.mutating, read: s.v2.read, total: s.calls });
  }
  const x0 = 208, x1 = 816, yStart = 104, band = 42, barH = 22, yMax = 90;
  const xOf = v => x0 + (v / yMax) * (x1 - x0);
  const parts = [frame(W, H, 'What the “mutating” counter actually counted',
    'Stacked bars of mutating and read-only tool calls for the submission task and the read-only analysis session, under v1 and v2 classification.')];
  parts.push(`<text class="t" x="32" y="32">What the counter actually counted</text>`);
  parts.push(`<text class="s" x="32" y="52">Tool calls by command shape · same sessions, classified by v1 and v2</text>`);
  parts.push(legend(78, [[C.kimi, 'counted as mutating'], [C.neutral, 'read-only']]));
  for (const tick of [0, 20, 40, 60, 80]) {
    const x = xOf(tick);
    parts.push(`<line x1="${x}" y1="94" x2="${x}" y2="${yStart + rows.length * band - 16}" stroke="${C.grid}" stroke-width="1"/>`);
    parts.push(`<text class="a" x="${x}" y="${yStart + rows.length * band + 4}" text-anchor="middle">${tick}</text>`);
  }
  rows.forEach((row, i) => {
    const y = yStart + i * band;
    parts.push(`<text class="a" x="${x0 - 12}" y="${y + 15}" text-anchor="end">${esc(row.label)}</text>`);
    const wMut = xOf(row.mutating) - x0;
    parts.push(`<path d="${hbarPath(x0, y, wMut, barH)}" fill="${C.kimi}"/>`);
    if (wMut > 58) parts.push(`<text class="v" x="${x0 + 8}" y="${y + 15}" fill="#1a1a19">${row.mutating}</text>`);
    else parts.push(`<text class="v" x="${x0 + wMut + 6}" y="${y + 15}">${row.mutating}</text>`);
    const wRead = xOf(row.mutating + row.read) - xOf(row.mutating) - 2;
    if (wRead > 0) {
      parts.push(`<path d="${hbarPath(x0 + wMut + 2, y, wRead, barH)}" fill="${C.neutral}"/>`);
      if (wRead > 40) parts.push(`<text class="v" x="${x0 + wMut + 10}" y="${y + 15}">${row.read}</text>`);
      else parts.push(`<text class="v" x="${x0 + wMut + wRead + 10}" y="${y + 15}">${row.read}</text>`);
    }
  });
  parts.push(`<text class="a" x="${x0}" y="296">read-only counts are the part that v1 misclassified as “mutating”</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

// attach simple accessor onto the data object
data.at = limit => data.after.find(a => a.limit === limit);

for (const [name, fn] of Object.entries({
  'fig1-kimi-share': figureShare,
  'fig2-mutating-counter': figureCounter,
  'fig3-provider-timeline': figureTimeline,
  'fig4-command-kind': figureCommands,
})) {
  fs.writeFileSync(path.join(outDir, `${name}.svg`), fn() + '\n');
  console.log('wrote', path.join('docs/versions/assets', `${name}.svg`));
}
