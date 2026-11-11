/**
 * Finds charts in a frame's layers.
 *
 * A chart drawn in Figma is shapes plus text: bars, dots or wedges, gridlines, value labels, axis
 * ticks, a legend. Without help, a screen reader hears the labels as loose words ("81K", "79K",
 * "OCTOBER TO DECEMBER"…) and nothing of the shapes. Tagged as one Figure with alt text, it hears
 * what the chart shows.
 *
 * A container is a chart when it holds 3+ data marks (repeated shapes — bars of one width or one
 * height — or a path over 3+ gridlines) and 3+ short number labels. The innermost one wins. Its
 * area is the marks plus the number labels; short text inside that area (or on its axes, just below
 * and left of it), and legend text beside a swatch, are its labels. The title and the source note sit outside the area and stay text.
 */

export interface ChartNode {
  id: string;
  name: string;
  kind: 'text' | 'shape' | 'container';
  /** Frame coordinates, top-left origin. */
  box: { x: number; y: number; w: number; h: number };
  text?: string;
  /** Shapes: a straight line or a hairline rectangle (gridline, axis, divider). */
  line?: boolean;
  /** Shapes: an open or curved path (a line chart's line, a pie wedge). */
  path?: boolean;
  /** Containers: a frame with a visible fill of its own — a bar built as a frame, its label inside. */
  filled?: boolean;
  children: ChartNode[];
}

export interface Chart {
  id: string;
  name: string;
  box: { x: number; y: number; w: number; h: number };
  /** Text layers that belong to the chart, in layer order. */
  labels: string[];
}

const norm = (s = '') => s.replace(/\s+/g, ' ').trim();
const words = (s = '') => norm(s).split(' ').filter(Boolean).length;
/** A value or tick: "81K", "+8 pp", "51%", "$1.2M", "2026" — not a legend entry like "FILED FY24". */
const isNumberLabel = (s = '') => /^[+\-−–]?[$€£]?\d[\d,.]*\s*(%|pp|pts?|[kmb]|bn|mn|x)?$/i.test(norm(s));

type Box = ChartNode['box'];
const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;
const union = (bs: Box[]): Box => {
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map(right)) - x, h: Math.max(...bs.map(bottom)) - y };
};
const centerIn = (b: Box, r: Box) => {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return cx >= r.x && cx <= right(r) && cy >= r.y && cy <= bottom(r);
};

function leaves(n: ChartNode, out: { shapes: ChartNode[]; texts: ChartNode[] } = { shapes: [], texts: [] }) {
  if (n.kind === 'shape') out.shapes.push(n);
  else if (n.kind === 'text') out.texts.push(n);
  else {
    // A filled frame draws a box of its own: a bar, with its label and value inside.
    if (n.filled) out.shapes.push({ ...n, kind: 'shape', children: [] });
    for (const c of n.children) leaves(c, out);
  }
  return out;
}

/** The size most marks share, with how many share it (within 1pt). */
function repeated(values: number[]): number {
  let best = 0;
  for (const v of values) best = Math.max(best, values.filter((w) => Math.abs(w - v) <= 1).length);
  return best;
}

function asChart(n: ChartNode): Chart | null {
  if (n.kind !== 'container') return null;
  const { shapes, texts } = leaves(n);
  const area = n.box.w * n.box.h || 1;
  const swatch = (s: ChartNode) => s.box.w < 16 && s.box.h < 16 && !s.line;
  // Backgrounds and card fills aren't data.
  const marks = shapes.filter((s) => s.box.w * s.box.h < 0.5 * area && !swatch(s));
  const solid = marks.filter((s) => !s.line && !s.path);
  const lines = marks.filter((s) => s.line);
  const paths = marks.filter((s) => s.path);
  // Bars share a width and differ in height (or the reverse). Same-size boxes are cards, not data.
  const varies = (xs: number[]) => Math.max(...xs) - Math.min(...xs) > 0.1 * Math.max(...xs);
  const bars = solid.length >= 3 && (
    (repeated(solid.map((s) => s.box.w)) >= 3 && varies(solid.map((s) => s.box.h))) ||
    (repeated(solid.map((s) => s.box.h)) >= 3 && varies(solid.map((s) => s.box.w))));
  const plotted = (paths.length >= 1 || solid.length >= 3) && lines.length >= 3;
  const numbers = texts.filter((t) => isNumberLabel(t.text));
  if (!(bars || plotted) || numbers.length < 3) return null;

  let region = union([...marks.filter((s) => !s.line || bars || plotted), ...numbers].map((s) => s.box));
  const labels = new Set(numbers.map((t) => t.id));
  // Short text in that area, or just below or left of it (category names under the bars, on the axis).
  const axes = { x: region.x - 32, y: region.y, w: region.w + 32, h: region.h + 32 };
  for (const t of texts) if (words(t.text) <= 4 && !/^(source|note)s?\b/i.test(norm(t.text)) && centerIn(t.box, axes)) labels.add(t.id);
  // Legend: text right beside a small swatch.
  const legend: Box[] = [];
  for (const sw of shapes.filter(swatch))
    for (const t of texts)
      if (t.box.x - right(sw.box) >= -1 && t.box.x - right(sw.box) <= 24 && Math.abs(t.box.y + t.box.h / 2 - (sw.box.y + sw.box.h / 2)) <= 8 && words(t.text) <= 6) {
        labels.add(t.id);
        legend.push(sw.box, t.box);
      }
  const mine = texts.filter((t) => labels.has(t.id));
  // The figure covers everything it stands for: marks, values, axis names, legend.
  return { id: n.id, name: n.name, box: union([region, ...legend, ...mine.map((t) => t.box)]), labels: mine.map((t) => t.id) };
}

/**
 * Innermost chart containers in the tree. Exception: a grouped bar chart is often built as one
 * group per category, each of which looks like a small chart on its own. When 2+ found charts sit
 * on one baseline (or one left edge, for horizontal bars) and their container is a chart too, the
 * container is the chart.
 */
export function findCharts(root: ChartNode): Chart[] {
  const charts = findChartContainers(root);
  // A label left outside the chart's group in the layers (one bar's category name dropped a level
  // up) is still on the chart: short text sitting on a chart's area joins it.
  const taken = new Set(charts.flatMap((c) => c.labels));
  for (const t of leaves(root).texts) {
    if (taken.has(t.id) || words(t.text) > 4 || /^(source|note)s?\b/i.test(norm(t.text))) continue;
    const chart = charts.find((c) => centerIn(t.box, c.box));
    if (chart) { chart.labels.push(t.id); taken.add(t.id); }
  }
  return charts;
}

function findChartContainers(root: ChartNode): Chart[] {
  const walk = (n: ChartNode): Chart[] => {
    const inner = n.children.flatMap(walk);
    if (n === root) return inner;
    if (!inner.length) {
      const chart = asChart(n);
      return chart ? [chart] : [];
    }
    if (inner.length >= 2) {
      const same = (f: (b: Box) => number) => inner.every((c) => Math.abs(f(c.box) - f(inner[0].box)) <= 4);
      const chart = same(bottom) || same((b) => b.x) ? asChart(n) : null;
      if (chart) return [chart];
    }
    return inner;
  };
  return walk(root);
}

/**
 * A chart's container comes before its contents in layer order, so the figure would be read before
 * the chart's own title. Move each chart to just before its first label instead: title, subtitle,
 * then the figure (which stands for the labels).
 */
export function placeCharts<T>(order: T[], idOf: (x: T) => string, charts: Array<Pick<Chart, 'id' | 'labels'>>): T[] {
  const out = [...order];
  for (const chart of charts) {
    const from = out.findIndex((x) => idOf(x) === chart.id);
    if (from < 0) continue;
    const labels = new Set(chart.labels);
    const [item] = out.splice(from, 1);
    const at = out.findIndex((x) => labels.has(idOf(x)));
    out.splice(at < 0 ? from : at, 0, item);
  }
  return out;
}
