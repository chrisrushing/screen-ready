/**
 * Reading order from the layer structure, not just position.
 *
 * Designers already express grouping: a heading and its paragraph sit in one frame, a list is a
 * vertical auto-layout, a card is a group. Sorting every text layer by position throws that away —
 * two side-by-side Q&A blocks come out heading, heading, body, body. So we walk the tree:
 *
 *   - Auto-layout frames: children are already in reading order (that's how auto-layout flows).
 *     Absolutely positioned children are read after the flow.
 *   - Everything else (plain frames, groups, sections): sort the children by position, as blocks,
 *     then read inside each block before moving to the next.
 *
 * Sorting sibling blocks by position is a small layout problem of its own (see sortBlocks).
 */

export interface Box { x: number; y: number; w: number; h: number }

export interface OrderNode {
  id: string;
  box: Box;
  /** True for the things we tag: text layers and images. */
  item: boolean;
  /** Auto-layout container: children are already in flow order. */
  flow: boolean;
  /** Ignores its auto-layout parent's flow. */
  absolute: boolean;
  children: OrderNode[];
}

export interface Ordered {
  id: string;
  /** Id of the top-level block (direct child of the frame) the item belongs to, for display. */
  group: string;
}

const EPS = 1; // px: edges that merely touch don't count as overlapping

const top = (n: OrderNode) => n.box.y;
const bottom = (n: OrderNode) => n.box.y + n.box.h;
const left = (n: OrderNode) => n.box.x;
const right = (n: OrderNode) => n.box.x + n.box.w;
const overlapY = (a: OrderNode, b: OrderNode) => top(a) < bottom(b) - EPS && top(b) < bottom(a) - EPS;

/** Splits blocks into bands along one axis wherever there is a clean gap between them. */
function bands(nodes: OrderNode[], axis: 'x' | 'y'): OrderNode[][] {
  const start = axis === 'y' ? top : left;
  const end = axis === 'y' ? bottom : right;
  const sorted = [...nodes].sort((a, b) => start(a) - start(b));
  const out: OrderNode[][] = [];
  let reach = -Infinity;
  for (const n of sorted) {
    if (out.length && start(n) < reach - EPS) {
      out[out.length - 1].push(n);
      reach = Math.max(reach, end(n));
    } else {
      out.push([n]);
      reach = end(n);
    }
  }
  return out;
}

/** Index of the band that starts after the given gap. */
function cutAt(groups: OrderNode[][], axis: 'x' | 'y', gap: number): number {
  const start = axis === 'y' ? top : left;
  const end = axis === 'y' ? bottom : right;
  for (let k = 1; k < groups.length; k++)
    if (Math.min(...groups[k].map(start)) - Math.max(...groups[k - 1].map(end)) >= gap) return k;
  return groups.length;
}

/** The widest clear gap between consecutive bands along an axis (0 for a single band). */
function widestGap(groups: OrderNode[][], axis: 'x' | 'y'): number {
  const start = axis === 'y' ? top : left;
  const end = axis === 'y' ? bottom : right;
  let widest = 0;
  for (let k = 1; k < groups.length; k++)
    widest = Math.max(widest, Math.min(...groups[k].map(start)) - Math.max(...groups[k - 1].map(end)));
  return widest;
}

const byTopLeft = (nodes: OrderNode[], rtl = false) =>
  [...nodes].sort((a, b) => top(a) - top(b) || (rtl ? right(b) - right(a) : left(a) - left(b)));

/** A page written right to left (Arabic, Hebrew…) reads its columns right to left too. */
export function isRtlText(texts: string[]): boolean {
  let rtl = 0, ltr = 0;
  for (const t of texts) for (const ch of t) {
    if (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(ch)) rtl++;
    else if (/\p{L}/u.test(ch)) ltr++;
  }
  return rtl > ltr;
}

/**
 * Orders sibling blocks the way a reader scans them: rows top to bottom, left to right within a
 * row, and down each column inside a row before moving right (recursive XY-cut, rows first).
 *
 * One refinement matters a lot for slides: a tall block beside several rows (a full-height photo,
 * a sidebar) would otherwise glue those rows into one band and force column-first reading. So we
 * set such "spanning" blocks aside, cut the rest into rows, then slot each spanning block into the
 * row where it starts, by its horizontal position.
 */
export function sortBlocks(nodes: OrderNode[], rtl = false): OrderNode[] {
  if (nodes.length <= 1) return nodes;

  // Cut at the widest clear gap first, rows or columns, then decide again on each side (XY-cut).
  // Loose text set in three columns, each with its own title, reads down each column — not all
  // three titles first — while a footer far below still comes last. Only when the columns' gutter
  // is the widest gap; a page cut into rows keeps the row-by-row reading below.
  const allCols = bands(nodes, 'x'), allRows = bands(nodes, 'y');
  const gx = widestGap(allCols, 'x'), gy = widestGap(allRows, 'y');
  if (allCols.length > 1 && gx > gy) {
    if (rtl) allCols.reverse();
    return allCols.flatMap((col) => sortBlocks(col, rtl));
  }
  if (allRows.length > 1 && gy > gx && allCols.length > 1) {
    // Rows win only at their widest gap: split there, and decide again above and below.
    const k = cutAt(allRows, 'y', gy);
    const above = allRows.slice(0, k).flat(), below = allRows.slice(k).flat();
    if (above.length && below.length && (bands(above, 'x').length > 1 || bands(below, 'x').length > 1))
      return [...sortBlocks(above, rtl), ...sortBlocks(below, rtl)];
  }

  const spans = (n: OrderNode) => {
    const beside = nodes.filter((m) => m !== n && overlapY(n, m));
    return beside.some((a, i) => beside.some((b, j) => j > i && !overlapY(a, b)));
  };
  const spanning = nodes.filter(spans);
  const rest = nodes.filter((n) => !spanning.includes(n));
  if (!rest.length) return byTopLeft(nodes, rtl);

  const rows = bands(rest, 'y');
  const ordered = rows.map((row) => {
    if (row.length === 1) return row;
    const cols = bands(row, 'x');
    if (rtl) cols.reverse();
    if (cols.length === 1) return rows.length === 1 ? byTopLeft(row, rtl) : sortBlocks(row, rtl);
    return cols.flatMap((col) => sortBlocks(col, rtl));
  });

  for (const s of spanning.sort((a, b) => top(a) - top(b) || left(a) - left(b))) {
    let r = rows.findIndex((row) => top(s) < Math.max(...row.map(bottom)) - EPS);
    if (r < 0) r = rows.length - 1;
    // A tall column of text on the right waits for the rows to its left that it runs beside: a
    // page title under an eyebrow on the left is read before the columns that start level with the
    // eyebrow. (A photo beside the rows is read where it starts, as before.)
    const before = (n: OrderNode) => (rtl ? left(n) >= right(s) - EPS : right(n) <= left(s) + EPS);
    if (!s.item) for (let k = r + 1; k < rows.length; k++)
      if (rows[k].some((n) => before(n) && overlapY(n, s))) r = k;
    const row = ordered[r];
    const at = row.findIndex((n) => (rtl ? right(n) < right(s) : left(n) > left(s)));
    row.splice(at < 0 ? row.length : at, 0, s);
  }
  return ordered.flat();
}

/**
 * An auto-layout container's children in flow order, with absolutely positioned ones slotted in
 * where they sit along the flow — a headline laid over the top of a page is read first, not after
 * the footer.
 */
function withAbsolute(children: OrderNode[], rtl = false): OrderNode[] {
  const flow = children.filter((c) => !c.absolute);
  const loose = sortBlocks(children.filter((c) => c.absolute), rtl);
  if (!loose.length) return flow;
  if (!flow.length) return loose;
  const spread = (k: 'x' | 'y') => Math.max(...flow.map((c) => c.box[k])) - Math.min(...flow.map((c) => c.box[k]));
  const axis = spread('y') >= spread('x') ? 'y' : 'x';
  const before = new Map<number, OrderNode[]>();
  for (const a of loose) {
    const at = flow.findIndex((f) => f.box[axis] >= a.box[axis] - 1);
    const slot = at < 0 ? flow.length : at;
    before.set(slot, [...(before.get(slot) ?? []), a]);
  }
  return [...flow.flatMap((f, k) => [...(before.get(k) ?? []), f]), ...(before.get(flow.length) ?? [])];
}

const area = (n: OrderNode) => Math.max(0, n.box.w) * Math.max(0, n.box.h);
const overlapArea = (a: OrderNode, b: OrderNode) =>
  Math.max(0, Math.min(right(a), right(b)) - Math.max(left(a), left(b))) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(top(a), top(b)));

/**
 * A layer laid on top of another block without being inside it in the layers — a chart's title
 * placed over its card, a caption floated onto a column — belongs to that block. Each such layer
 * moves into the smallest sibling that holds it (nine tenths of its area or more), and on down
 * into that block's own parts, so it's read where it sits, not as a block of its own after the
 * rest of the page. Inside an auto-layout block it's slotted in by position, like an absolute layer.
 */
function adopt(kids: OrderNode[]): OrderNode[] {
  if (kids.length < 2 || kids.length > 300) return kids;
  const host = new Map<OrderNode, OrderNode>();
  for (const c of kids) {
    let best: OrderNode | undefined;
    for (const s of kids)
      if (s !== c && !s.item && s.children.length && area(s) > area(c) && overlapArea(s, c) >= 0.9 * Math.max(area(c), 1) &&
        (!best || area(s) < area(best))) best = s;
    if (best) host.set(c, best);
  }
  if (!host.size) return kids;
  const built = new Map<OrderNode, OrderNode>();
  const build = (n: OrderNode): OrderNode => {
    const done = built.get(n);
    if (done) return done;
    const extra = kids.filter((c) => host.get(c) === n).map((c) => (n.flow ? { ...build(c), absolute: true } : build(c)));
    const out = extra.length ? { ...n, children: adopt([...n.children, ...extra]) } : n;
    built.set(n, out);
    return out;
  };
  return kids.filter((c) => !host.has(c)).map(build);
}

/** Reading order of every item under `root`, with the top-level block each belongs to. */
export function readingOrder(root: OrderNode, { rtl = false } = {}): Ordered[] {
  const out: Ordered[] = [];
  const visit = (n: OrderNode, group: string) => {
    if (n.item) out.push({ id: n.id, group });
    if (!n.children.length) return;
    const children = adopt(n.children);
    const kids = n.flow ? withAbsolute(children, rtl) : sortBlocks(children, rtl);
    for (const k of kids) visit(k, n === root ? k.id : group);
  };
  visit(root, root.id);
  return out;
}
