/**
 * Drafts alt text for a chart from its own labels.
 *
 * A chart's labels already hold its data: category names, value labels, axis ticks, a legend. Read
 * by position, they pair up ("NORTH" sits just above "13,265"; "427K" sits over "Q1 FY24"), and
 * the pairs make a useful first draft: "Chart, Projects by Region: North 13,265; South 6,294…".
 * A person still approves it; when the geometry is unclear, the draft just lists the values.
 */

import type { ItemState } from './messages.ts';

type PdfBox = [number, number, number, number];

/** A label in top-left coordinates (y grows downward), so "above" and "below" read naturally. */
interface Label {
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Numeric value, for value labels and ticks. */
  value?: number;
}

export interface ChartAltDraft {
  alt: string;
  /** 'paired': every value was matched to a category. 'listed': the draft lists what it found. */
  confidence: 'paired' | 'listed';
}

const MAX = 300;
const norm = (s = '') => s.replace(/\s+/g, ' ').trim();

/** "13,265" → 13265, "81K" → 81000, "+8 pp" → 8, "−3%" → −3, "$1.2M" → 1200000. Else undefined. */
export function parseValue(s: string): number | undefined {
  const m = norm(s).match(/^([+\-−–]?)\s*[$€£]?\s*(\d[\d,]*(?:\.\d+)?)\s*(%|pp|pts?|[kmb]|bn|mn|x)?$/i);
  if (!m) return undefined;
  const scale: Record<string, number> = { k: 1e3, m: 1e6, mn: 1e6, b: 1e9, bn: 1e9 };
  const n = parseFloat(m[2].replace(/,/g, '')) * (scale[(m[3] ?? '').toLowerCase()] ?? 1);
  return m[1] && m[1] !== '+' ? -n : n;
}

/** A year on an axis ("2024") names a category; it isn't a value. */
const isYear = (s: string) => /^(19|20)\d\d$/.test(norm(s));

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'per']);

/** "NORTH REGION" → "North Region", "APRIL TO JUNE" → "April to June"; "FILED FY24" keeps "FY24". */
export function titleCase(s: string): string {
  s = norm(s);
  if (/\p{Ll}/u.test(s) || !/\p{Lu}/u.test(s)) return s; // only ALL CAPS is rewritten
  return s
    .split(' ')
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (i > 0 && SMALL.has(lw)) return lw;
      // Codes and acronyms stay: FY24, Q3, U.S., AT&T, short ones like US or AI.
      if (/[\d.&]/.test(w) || (w.length <= 2 && !SMALL.has(lw))) return w;
      return lw.charAt(0).toUpperCase() + lw.slice(1);
    })
    .join(' ');
}

function toLabel(i: ItemState): Label {
  const [x0, y0, x1, y1] = i.bbox;
  const top = -y1, bottom = -y0;
  const text = norm(i.text);
  const value = isYear(text) ? undefined : parseValue(text);
  return { text, x0, x1, top, bottom, cx: (x0 + x1) / 2, cy: (top + bottom) / 2, w: x1 - x0, h: bottom - top, value };
}

/** Labels sharing a key (within tol), as clusters of 2+. */
function clusters(ls: Label[], key: (l: Label) => number, tol: number): Label[][] {
  const sorted = [...ls].sort((a, b) => key(a) - key(b));
  const out: Label[][] = [];
  let cur: Label[] = [];
  for (const l of sorted) {
    if (cur.length && key(l) - key(cur[cur.length - 1]) > tol) {
      if (cur.length >= 2) out.push(cur);
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

const evenly = (xs: number[], tol: number) => {
  const d = xs.slice(1).map((x, i) => x - xs[i]);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  return mean !== 0 && d.every((x) => Math.abs(x - mean) <= tol * Math.abs(mean));
};

/** Axis steps are round: 1, 2, 2.5 or 5 times a power of ten, and every tick is a multiple of it. */
function niceStep(vs: number[]): boolean {
  const step = Math.abs(vs[1] - vs[0]);
  const mantissa = step / 10 ** Math.floor(Math.log10(step));
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  return [1, 2, 2.5, 5, 10].some((m) => near(mantissa, m)) && vs.every((v) => near(v / step, Math.round(v / step)));
}

/**
 * Axis ticks: 3+ numbers in one column (or row) near the chart's edge, evenly spaced on the page
 * and in round steps of value (0, 50K, 100K…). A ranking's values can line up in a column too, but
 * they don't step by a round amount, so they stay data.
 */
function findTicks(nums: Label[], chart: { x0: number; x1: number; top: number; bottom: number }): Label[][] {
  const scales: Label[][] = [];
  const isScale = (g: Label[], pos: (l: Label) => number) => {
    const s = [...g].sort((a, b) => pos(a) - pos(b));
    const vs = s.map((l) => l.value!);
    const range = Math.max(...vs) - Math.min(...vs);
    return s.length >= 3 && range > 0 && evenly(vs, 0.01) && niceStep(vs) && evenly(s.map(pos), 0.15);
  };
  const W = chart.x1 - chart.x0, H = chart.bottom - chart.top;
  const nearSide = (g: Label[]) => { const x = g[0].cx; return x - chart.x0 <= 0.2 * W || chart.x1 - x <= 0.2 * W; };
  const nearEnd = (g: Label[]) => { const y = g[0].cy; return y - chart.top <= 0.2 * H || chart.bottom - y <= 0.2 * H; };
  // Y-axis ticks are usually right-aligned against the axis; left or centered also happen.
  for (const key of [(l: Label) => l.x1, (l: Label) => l.x0, (l: Label) => l.cx])
    for (const g of clusters(nums, key, 3)) if (nearSide(g) && isScale(g, (l) => l.cy)) scales.push(g);
  for (const g of clusters(nums, (l) => l.cy, 3)) if (nearEnd(g) && isScale(g, (l) => l.cx)) scales.push(g);
  return scales;
}

type Orientation = 'row' | 'col';
interface Group { labels: Label[]; dir: Orientation }

/** Text labels lined up in a row (category names under columns) or a column (a legend, a ranking). */
function textGroups(texts: Label[]): Group[] {
  const seen = new Set<string>();
  const out: Group[] = [];
  const add = (labels: Label[], dir: Orientation) => {
    const k = dir + labels.map((l) => texts.indexOf(l)).sort().join(',');
    if (!seen.has(k)) seen.add(k), out.push({ labels, dir });
  };
  const h = Math.max(3, Math.min(...texts.map((t) => t.h)) / 2);
  for (const g of clusters(texts, (l) => l.cy, h)) add(g, 'row');
  for (const key of [(l: Label) => l.x0, (l: Label) => l.cx, (l: Label) => l.x1])
    for (const g of clusters(texts, key, 3)) add(g, 'col');
  return out;
}

/** Which category each value belongs to (by index into the group), or -1. */
type Assignment = number[];

/**
 * Values under (or over) each category of a row, or beside each category of a column: the nearest
 * category along the shared axis, within half the spacing between categories.
 */
function byAxis(g: Group, values: Label[]): Assignment {
  const pos = (l: Label) => (g.dir === 'row' ? l.cx : l.cy);
  const half = (l: Label) => (g.dir === 'row' ? l.w : l.h) / 2;
  const ps = g.labels.map(pos);
  const reach = g.labels.map((c, i) => {
    const gaps = ps.filter((_, j) => j !== i).map((p) => Math.abs(p - ps[i]));
    return Math.max(half(c), gaps.length ? Math.min(...gaps) / 2 : half(c));
  });
  return values.map((v) => {
    let best = -1, bestD = Infinity;
    g.labels.forEach((c, i) => {
      const d = Math.abs(pos(v) - pos(c));
      if (d <= reach[i] && d < bestD) (best = i), (bestD = d);
    });
    return best;
  });
}

/**
 * Label and value stacked in one column ("NORTH" over "13,265", then "SOUTH" over "6,294"…), or
 * inline in one row. Nearest-neighbor fails here (each value is about as close to the next label as
 * to its own), so pair by order when labels and values alternate.
 */
function byStack(g: Group, values: Label[]): Assignment {
  const none = values.map(() => -1);
  const lo = Math.min(...g.labels.map((l) => (g.dir === 'col' ? l.x0 : l.top)));
  const hi = Math.max(...g.labels.map((l) => (g.dir === 'col' ? l.x1 : l.bottom)));
  const inBand = values.filter((v) => (g.dir === 'col' ? v.x0 < hi && v.x1 > lo : v.top < hi && v.bottom > lo));
  if (inBand.length !== g.labels.length) return none;
  const pos = (l: Label) => (g.dir === 'col' ? l.cy : l.cx);
  const seq = [...g.labels.map((l) => ({ l, cat: true })), ...inBand.map((l) => ({ l, cat: false }))].sort((a, b) => pos(a.l) - pos(b.l));
  if (!seq.every((s, i) => s.cat === (i % 2 === 0 ? seq[0].cat : !seq[0].cat))) return none;
  const out = [...none];
  for (let i = 0; i < seq.length; i += 2) {
    const [cat, val] = seq[0].cat ? [seq[i], seq[i + 1]] : [seq[i + 1], seq[i]];
    out[values.indexOf(val.l)] = g.labels.indexOf(cat.l);
  }
  return out;
}

interface Pairing { group: Group; assign: Assignment; covered: number; assigned: number; even: boolean }

function score(group: Group, assign: Assignment): Pairing {
  const counts = group.labels.map((_, i) => assign.filter((a) => a === i).length);
  return { group, assign, covered: counts.filter((c) => c > 0).length, assigned: assign.filter((a) => a >= 0).length, even: counts.every((c) => c === counts[0]) };
}

/** Best pairing: every category gets a value, then the most values placed, then even counts. */
function bestPairing(groups: Group[], values: Label[]): Pairing | null {
  let best: Pairing | null = null;
  for (const g of groups)
    for (const a of [byAxis(g, values), byStack(g, values)]) {
      const p = score(g, a);
      if (p.covered < g.labels.length) continue; // a category with no value isn't a category (an axis title, a legend)
      if (!best || p.assigned > best.assigned || (p.assigned === best.assigned && p.even && !best.even)) best = p;
    }
  return best;
}

const fmtList = (xs: string[]) => xs.join(', ');

/** "Highest: North 13,265; lowest: West 6,130." from (name, value label) pairs. */
function extremes(items: Array<{ name: string; label: Label }>): string {
  const withV = items.filter((i) => i.label.value !== undefined);
  if (withV.length < 2) return '';
  const hi = withV.reduce((a, b) => (b.label.value! > a.label.value! ? b : a));
  const lo = withV.reduce((a, b) => (b.label.value! < a.label.value! ? b : a));
  return `Highest: ${hi.name} ${hi.label.text}; lowest: ${lo.name} ${lo.label.text}.`;
}

/**
 * A draft alt text for a chart, from its labels (text items with `inChart` = the chart's id).
 * `chartBox` and label bboxes are PDF points, origin bottom-left. `title` is the chart's heading, if
 * known; `kind` names the chart type when the caller knows it ("Bar chart").
 */
export function draftChartAlt(labels: ItemState[], chartBox: PdfBox, title?: string, kind = 'Chart'): ChartAltDraft {
  const ls = labels.filter((l) => norm(l.text)).map(toLabel);
  const chart = { x0: chartBox[0], x1: chartBox[2], top: -chartBox[3], bottom: -chartBox[1] };
  const nums = ls.filter((l) => l.value !== undefined);
  const scales = findTicks(nums, chart);
  const ticks = new Set(scales.flat());
  const values = nums.filter((l) => !ticks.has(l));
  // Short text only: a long sentence inside the chart is a note, not a category.
  const texts = ls.filter((l) => l.value === undefined && l.text.split(' ').length <= 6);
  const t = title ? norm(title) : '';
  const head = t ? `${kind}, ${t}` : kind;

  // "Axis from 0 to 200K", from the longest scale.
  const scale = scales.sort((a, b) => b.length - a.length)[0];
  const axis = scale ? (() => {
    const s = [...scale].sort((a, b) => a.value! - b.value!);
    return `Axis from ${s[0].text} to ${s[s.length - 1].text}.`;
  })() : '';
  const withAxis = (s: string) => (axis && s.length + axis.length + 1 <= MAX ? `${s} ${axis}` : s);

  const groups = texts.length >= 2 && values.length ? textGroups(texts) : [];
  const pairing = bestPairing(groups, values);
  if (pairing && pairing.even) {
    const { group, assign } = pairing;
    const along = (l: Label) => (group.dir === 'row' ? l.cx : l.cy);
    const cats = group.labels.map((label, i) => ({ label, i })).sort((a, b) => along(a.label) - along(b.label));
    const valuesOf = (i: number) =>
      values.filter((_, j) => assign[j] === i).sort((a, b) => (group.dir === 'row' ? a.cx - b.cx : a.cy - b.cy));
    const leftover = values.filter((_, j) => assign[j] < 0);
    const extra = leftover.length ? ` Other values: ${fmtList(leftover.map((v) => v.text))}.` : '';
    const confidence = leftover.length ? 'listed' : 'paired';
    const k = valuesOf(cats[0].i).length;

    if (k === 1) {
      const pairs = cats.map((c) => ({ name: titleCase(c.label.text), label: valuesOf(c.i)[0] }));
      const full = `${head}: ${pairs.map((p) => `${p.name} ${p.label.text}`).join('; ')}.${extra}`;
      if (full.length <= MAX) return { alt: full, confidence };
      return { alt: `${head}: ${pairs.length} items. ${extremes(pairs)}`, confidence };
    }

    // Grouped bars: several values per category, in series (legend) order. The legend is another
    // lined-up group of short labels, ideally one per series.
    const inGroup = new Set(group.labels);
    const legend = groups
      .filter((g) => g.labels.every((l) => !inGroup.has(l)))
      .sort((a, b) => Math.abs(a.labels.length - k) - Math.abs(b.labels.length - k))[0];
    const series = legend ? [...legend.labels].sort((a, b) => (legend.dir === 'row' ? a.cx - b.cx : a.cy - b.cy)).map((l) => titleCase(l.text)) : [];
    const seriesPart = series.length ? ` Series: ${fmtList(series)}.` : '';
    const rows = cats.map((c) => `${titleCase(c.label.text)}: ${fmtList(valuesOf(c.i).map((v) => v.text))}`);
    const full = `${head}.${seriesPart} ${rows.join('; ')}.${extra}`;
    if (full.length <= MAX) return { alt: withAxis(full), confidence };
    // Too long to hear comfortably: say the shape of it, and the extremes.
    const named = cats.flatMap((c) =>
      valuesOf(c.i).map((label, s) => ({ name: series.length === k ? `${titleCase(c.label.text)} (${series[s]})` : titleCase(c.label.text), label })),
    );
    const first = titleCase(cats[0].label.text), last = titleCase(cats[cats.length - 1].label.text);
    return { alt: withAxis(`${head}.${seriesPart} ${cats.length} groups, ${first} to ${last}. ${extremes(named)}`), confidence };
  }

  // No clean pairing: list what's there, in reading order.
  const spreadX = values.length ? Math.max(...values.map((v) => v.cx)) - Math.min(...values.map((v) => v.cx)) : 0;
  const spreadY = values.length ? Math.max(...values.map((v) => v.cy)) - Math.min(...values.map((v) => v.cy)) : 0;
  const ordered = [...values].sort((a, b) => (spreadX >= spreadY ? a.cx - b.cx : a.cy - b.cy));
  const lead = t ? `${kind}: ${t}.` : `${kind}.`;
  const names = texts.length ? ` Labels: ${fmtList(texts.map((l) => titleCase(l.text)))}.` : '';
  let alt = `${lead}${names}${ordered.length ? ` Values: ${fmtList(ordered.map((v) => v.text))}.` : ''}`;
  if (alt.length > MAX) {
    const vs = ordered.filter((v) => v.value !== undefined).sort((a, b) => a.value! - b.value!);
    const range = vs.length ? ` ${vs.length} values, from ${vs[0].text} to ${vs[vs.length - 1].text}.` : '';
    alt = `${lead}${names.length + lead.length + range.length <= MAX ? names : ''}${range}`;
  }
  return { alt: withAxis(alt), confidence: 'listed' };
}
