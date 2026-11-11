/**
 * Finds tables and lists in a frame's text layers, from layout alone.
 *
 * Designers rarely build tables and lists with Figma's list formatting or anything machine-readable —
 * a table is text layers lined up in columns, a table of contents is numbers beside titles. So:
 *
 * Tables: text layers are clustered into columns by left edge and into rows by vertical overlap. A
 * run of 3+ consecutive rows sharing 2+ columns is a table when each column keeps one style down its
 * body rows (a stats grid alternating big numbers and captions does not). The first row is the
 * header row when it is bolder or in caps; otherwise a bold or number-like first column is the header
 * column. Without either, it isn't treated as a table — a table without headers helps no one.
 *
 * Lists: two columns where the first holds short labels (01, IV, •, a.) beside text — a table of
 * contents — become a labelled list. A line ending in ":" followed by 2+ aligned items in the same
 * style ("…exempt from the cap, including:") becomes a list of those items.
 */
import type { FrameState, ItemState } from './messages.ts';
import type { TextRole } from './types.ts';

export interface TableSuggestion {
  id: string;
  frameId: string;
  /** rows → cells → text layer ids (a cell can be empty, or hold more than one layer). */
  rows: string[][][];
  headerRow: boolean;
  /** Header rows at the top, when more than one (a merged heading over its sub-columns). */
  headerRows?: number;
  headerCol: boolean;
  /** A short line of text right above the table, left-aligned with it: its title. */
  caption?: string;
}

export interface ListSuggestion {
  id: string;
  frameId: string;
  items: Array<{ label?: string; body: string[] }>;
}

const norm = (s = '') => s.replace(/\s+/g, ' ').trim();
const words = (s = '') => norm(s).split(' ').filter(Boolean).length;
const bold = (i: ItemState) => (i.fontWeight ?? 400) >= 600;
const styleKey = (i: ItemState) => `${i.fontFamily ?? '?'}|${Math.round(i.fontSize ?? 0)}|${i.fontWeight ?? 400}|${i.italic ? 'i' : ''}`;
const isLabel = (s: string) => {
  const t = norm(s);
  return t.length <= 4 && (/^\d{1,3}[.)]?$/.test(t) || /^[ivxlc]+[.)]?$/i.test(t) || /^[a-z][.)]$/i.test(t) || /^[•·◦▪–—\-*]$/.test(t));
};
const numberish = (s: string) => /\d/.test(s) && norm(s).length <= 12;

/** Groups values that sit within tol of each other (1-D clustering of sorted values). */
function cluster(values: number[], tol: number): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const id = new Array<number>(values.length);
  let c = -1, last = -Infinity;
  for (const [v, i] of order) {
    if (v - last > tol) c++;
    id[i] = c;
    last = v;
  }
  return id;
}

export function suggestStructures(
  frames: FrameState[],
  roleOf: (i: ItemState) => TextRole | undefined,
): { tables: TableSuggestion[]; lists: ListSuggestion[] } {
  const tables: TableSuggestion[] = [];
  const lists: ListSuggestion[] = [];
  const claimed = new Set<string>();

  for (const frame of frames) {
    const texts = frame.items.filter((i) => i.kind === 'text');
    const usable = texts.filter((i) => {
      const r = roleOf(i);
      // Suggested headings can be table headers or ToC entries; headings the designer chose can't.
      // A list entry can run long (a sentence or two after "01"); a table cell can't (see below).
      return !i.inChart && r !== 'Artifact' && !(i.roleSet && r && /^H[1-6]$/.test(r)) && words(i.text) <= 80;
    });

    // Look for tables one layout block at a time — a page's two text columns are separate blocks
    // even when their rows line up — and inside a block, one lane at a time (see lanes()).
    const byGroup = new Map<string, ItemState[]>();
    // Text placed straight on the frame (no group around it) is its own "block" in the layers; such
    // loose layers are one block here, so a table drawn as loose text can still line up across columns.
    const blockOf = (i: ItemState) => (!i.group || i.group === i.nodeId ? '' : i.group);
    for (const i of usable) byGroup.set(blockOf(i), [...(byGroup.get(blockOf(i)) ?? []), i]);
    for (const block of mergeStacked([...byGroup.values()])) for (const lane of lanes(block)) findGrids(lane);
  }
  colonLists(frames, roleOf, claimed, lists);
  bulletLists(frames, roleOf, claimed, lists);
  return { tables, lists };

  /**
   * Layout blocks stacked in the same column of the page (each row of a table of contents is often
   * its own frame) are one block for this purpose; blocks side by side stay apart.
   */
  function mergeStacked(blocks: ItemState[][]): ItemState[][] {
    const ext = blocks.map((b) => [Math.min(...b.map((i) => i.bbox[0])), Math.max(...b.map((i) => i.bbox[2]))]);
    const parent = blocks.map((_, k) => k);
    const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
    for (let a = 0; a < blocks.length; a++)
      for (let b = a + 1; b < blocks.length; b++) {
        const shared = Math.min(ext[a][1], ext[b][1]) - Math.max(ext[a][0], ext[b][0]);
        const narrower = Math.min(ext[a][1] - ext[a][0], ext[b][1] - ext[b][0]);
        if (shared > 0.5 * narrower) parent[find(a)] = find(b);
      }
    const out = new Map<number, ItemState[]>();
    blocks.forEach((b, k) => out.set(find(k), [...(out.get(find(k)) ?? []), ...b]));
    return [...out.values()];
  }

  /**
   * Splits a block where the gap between columns is wider than a gutter, so two tables side by side
   * stay two tables. A side with fewer than two real columns can't be a table on its own, so it stays
   * joined to its neighbor — a table with wide gutters, or a ToC's numbers far from its titles.
   */
  function lanes(items: ItemState[]): ItemState[][] {
    if (items.length < 4) return [];
    const colId = cluster(items.map((i) => i.bbox[0]), 6);
    const cols = new Map<number, ItemState[]>();
    items.forEach((i, k) => cols.set(colId[k], [...(cols.get(colId[k]) ?? []), i]));
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const ordered = [...cols.values()].map((xs) => ({ xs, x0: Math.min(...xs.map((i) => i.bbox[0])), x1: median(xs.map((i) => i.bbox[2])) }))
      .sort((a, b) => a.x0 - b.x0);
    // Segments between wide gaps, each remembering the gap before it.
    const segs: Array<{ cols: typeof ordered; gap: number }> = [];
    let reach = -Infinity;
    for (const c of ordered) {
      const gap = c.x0 - reach;
      if (!segs.length || gap > 32) segs.push({ cols: [], gap });
      segs[segs.length - 1].cols.push(c);
      reach = Math.max(reach, c.x1);
    }
    const real = (seg: (typeof segs)[number]) => seg.cols.filter((c) => c.xs.length >= 3).length;
    for (let k = 0; k < segs.length && segs.length > 1; ) {
      if (real(segs[k]) >= 2) { k++; continue; }
      // Join across the narrower of its two gaps.
      const left = k > 0 ? segs[k].gap : Infinity;
      const right = k + 1 < segs.length ? segs[k + 1].gap : Infinity;
      if (left <= right) { segs[k - 1].cols.push(...segs[k].cols); segs.splice(k, 1); k = Math.max(0, k - 1); }
      else { segs[k].cols.push(...segs[k + 1].cols); segs.splice(k + 1, 1); }
    }
    return segs.map((seg) => seg.cols.flatMap((c) => c.xs));
  }

  /**
   * A table's title: the nearest short line just above it, starting at its left edge, that is plain
   * text (a heading stays a heading, so it can still be jumped to).
   */
  function findCaption(frame: FrameState, tableTop: number, left: number, rowHeight: number): ItemState | undefined {
    const H = frame.height || 1;
    return frame.items
      .filter((i) => i.kind === 'text' && !claimed.has(i.nodeId) && !i.inChart && words(i.text) <= 14 && words(i.text) >= 2)
      .filter((i) => { const r = roleOf(i); return r !== 'Artifact' && !(r && /^H[1-6]$/.test(r)); })
      .filter((i) => Math.abs(i.bbox[0] - left) <= 12 && !/[.:]$/.test(norm(i.text)))
      .map((i) => ({ i, gap: tableTop - (H - i.bbox[1]) }))
      .filter(({ gap }) => gap >= 0 && gap <= Math.max(2 * rowHeight, 36))
      .sort((a, b) => a.gap - b.gap)[0]?.i;
  }

  function findGrids(usable: ItemState[]) {
    if (usable.length < 4) return;
    const frame = frames.find((f) => f.items.includes(usable[0]))!;
    const H = frame.height || 1;
    const top = (i: ItemState) => H - i.bbox[3];
    const bottom = (i: ItemState) => H - i.bbox[1];
    const used = claimed;

    // Columns by left edge; only edges shared by 3+ layers count.
    const colId = cluster(usable.map((i) => i.bbox[0]), 6);
    const colSize = new Map<number, number>();
    colId.forEach((c) => colSize.set(c, (colSize.get(c) ?? 0) + 1));
    const inCol = usable.map((i, k) => ({ i, c: colId[k] })).filter(({ c }) => (colSize.get(c) ?? 0) >= 3);
    const colX = new Map<number, number>();
    for (const { i, c } of inCol) colX.set(c, Math.min(colX.get(c) ?? Infinity, i.bbox[0]));

    // Rows: layers whose vertical extents overlap.
    const sorted = [...inCol].sort((a, b) => top(a.i) - top(b.i));
    const bands: Array<{ top: number; bottom: number; cells: Map<number, ItemState[]> }> = [];
    for (const x of sorted) {
      const b = bands[bands.length - 1];
      if (b && top(x.i) < b.bottom - 2) {
        b.bottom = Math.max(b.bottom, bottom(x.i));
        b.cells.set(x.c, [...(b.cells.get(x.c) ?? []), x.i]);
      } else {
        bands.push({ top: top(x.i), bottom: bottom(x.i), cells: new Map([[x.c, [x.i]]]) });
      }
    }

    // Runs of consecutive rows that share 2+ columns, without big gaps.
    const heights = bands.map((b) => b.bottom - b.top).sort((a, b) => a - b);
    const typical = heights[Math.floor(heights.length / 2)] || 20;
    let k = 0;
    while (k < bands.length) {
      const run = [bands[k]];
      let cols = new Set(bands[k].cells.keys());
      let j = k + 1;
      for (; j < bands.length; j++) {
        const b = bands[j];
        const shared = [...b.cells.keys()].filter((c) => cols.has(c)).length;
        const gap = b.top - run[run.length - 1].bottom;
        if (shared < 2 || gap > Math.max(2.5 * typical, 40)) break;
        run.push(b);
        cols = new Set([...cols, ...b.cells.keys()]);
      }
      k = j > k + 1 ? j : k + 1;
      if (run.length < 3 || cols.size < 2) continue;

      // Keep columns present in most rows; order them left to right.
      const columns = [...cols].filter((c) => run.filter((b) => b.cells.has(c)).length >= run.length * 0.6)
        .sort((a, b) => (colX.get(a) ?? 0) - (colX.get(b) ?? 0));
      if (columns.length < 2) continue;
      const cellsOf = (b: (typeof run)[number]) => columns.map((c) => b.cells.get(c) ?? []);
      const filled = (b: (typeof run)[number]) => cellsOf(b).filter((cell) => cell.length).length >= 2;
      // A heading row just above that names only some columns (a merged "Selection rate" over its
      // years) shares too few columns to start the run; it's still the table's top row.
      const above = bands[bands.indexOf(run[0]) - 1];
      if (above && above.cells.size >= 2 && [...above.cells.keys()].every((c) => columns.includes(c)) &&
        run[0].top - above.bottom <= Math.max(2.5 * typical, 40) && ![...above.cells.values()].flat().some((i) => used.has(i.nodeId)))
        run.unshift(above);
      while (run.length && !filled(run[0])) run.shift();
      while (run.length && !filled(run[run.length - 1])) run.pop();
      if (run.length < 3) continue;
      const first = run[0];
      // Header row: bold or caps over a body that isn't — or words over columns of numbers.
      const headCells = cellsOf(first).flat();
      const bodyValues = run.slice(1).flatMap((b) => cellsOf(b).slice(1).flat());
      const overNumbers = bodyValues.length > 0 && bodyValues.filter((i) => numberish(i.text ?? '')).length / bodyValues.length >= 0.7 &&
        headCells.every((i) => !numberish(i.text ?? ''));
      // Caps needs letters: "2021" or "13,265" isn't capitalized. And the first row has to look
      // different from the rows under it, column by column — a ranking in caps is not all headers.
      const caps = (i: ItemState) => !!i.upper || (/\p{L}/u.test(i.text ?? '') && norm(i.text) === norm(i.text).toUpperCase());
      // Heavier than the table's usual weight counts too: Medium headers over Regular cells.
      const weights = run.flatMap((b) => cellsOf(b).flat()).map((i) => i.fontWeight ?? 400).sort((a, b) => a - b);
      const usual = weights[Math.floor(weights.length / 2)] ?? 400;
      const heavy = (i: ItemState) => bold(i) || (i.fontWeight ?? 400) >= usual + 100;
      const emphasis = (i: ItemState) => `${heavy(i) ? 'b' : ''}${caps(i) ? 'c' : ''}`;
      const distinct = columns.filter((c) => {
        const head = first.cells.get(c)?.[0];
        const below = run.slice(1).flatMap((b) => b.cells.get(c) ?? []);
        return !!head && below.length > 0 && below.filter((x) => emphasis(x) === emphasis(head)).length / below.length < 0.5;
      }).length;
      const firstIsHeader = headCells.length >= 2 &&
        headCells.every((i) => heavy(i) || caps(i)) &&
        (distinct * 2 >= columns.length || overNumbers);
      // A second header row under the first (a merged "Selection rate" over "2026 · 2025").
      const second = firstIsHeader && run.length > 3 && cellsOf(run[1]).flat().length >= 2 && cellsOf(run[1]).flat().every((i) => heavy(i) || caps(i));
      const headerRows = firstIsHeader ? (second ? 2 : 1) : 0;
      const body = run.slice(headerRows);

      // A labelled list: two columns, short labels on the left, no header row.
      const leftItems = body.map((b) => b.cells.get(columns[0]) ?? []).flat();
      if (columns.length === 2 && !firstIsHeader && leftItems.length >= 2 && leftItems.every((i) => isLabel(i.text ?? ''))) {
        const items = body.map((b) => ({
          label: (b.cells.get(columns[0]) ?? [])[0]?.nodeId,
          body: (b.cells.get(columns[1]) ?? []).map((i) => i.nodeId),
        })).filter((it) => it.body.length);
        if (items.length >= 2) {
          lists.push({ id: `list:${items[0].label ?? items[0].body[0]}`, frameId: frame.id, items });
          for (const b of body) for (const c of columns) for (const i of b.cells.get(c) ?? []) used.add(i.nodeId);
        }
        continue;
      }
      // Paragraphs side by side are columns of text, not a table.
      if (body.some((b) => cellsOf(b).flat().some((i) => words(i.text) > 30))) continue;

      // Each column keeps one style down its body rows — a real table, not a stats grid.
      const consistent = columns.every((c) => {
        const keys = body.flatMap((b) => (b.cells.get(c) ?? []).map(styleKey));
        if (!keys.length) return true;
        const counts = new Map<string, number>();
        for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
        return Math.max(...counts.values()) / keys.length >= 0.8;
      });
      if (!consistent) continue;

      const firstCol = body.map((b) => b.cells.get(columns[0]) ?? []).flat();
      const headerCol = !firstIsHeader && firstCol.length > 0 &&
        firstCol.every((i) => bold(i) || numberish(i.text ?? '') || isLabel(i.text ?? ''));
      if (!firstIsHeader && !headerCol) continue; // no headers: not treated as a table

      const rows = run.map((b) => cellsOf(b).map((cell) => cell.map((i) => i.nodeId)));
      const caption = findCaption(frame, run[0].top, Math.min(...run.flatMap((b) => cellsOf(b).flat()).map((i) => i.bbox[0])), typical);
      tables.push({ id: `table:${rows[0].flat()[0]}`, frameId: frame.id, rows, headerRow: firstIsHeader, ...(headerRows > 1 ? { headerRows } : {}), headerCol, ...(caption ? { caption: caption.nodeId } : {}) });
      for (const r of rows) for (const cell of r) for (const id of cell) used.add(id);
      if (caption) used.add(caption.nodeId);
    }
  }
}

/**
 * Entries with a bullet drawn as a shape (a dot or a dash beside each, not a typed "•"): one list
 * per run of them that line up, in reading order.
 */
function bulletLists(frames: FrameState[], roleOf: (i: ItemState) => TextRole | undefined, used: Set<string>, lists: ListSuggestion[]) {
  for (const frame of frames) {
    let run: ItemState[] = [];
    const close = () => {
      if (run.length >= 2) {
        lists.push({ id: `list:${run[0].nodeId}`, frameId: frame.id, items: run.map((i) => ({ body: [i.nodeId] })) });
        for (const i of run) used.add(i.nodeId);
      }
      run = [];
    };
    for (const i of frame.items) {
      if (i.kind !== 'text') continue;
      const ok = i.bulleted && !used.has(i.nodeId) && roleOf(i) !== 'Artifact';
      if (!ok) { if (!used.has(i.nodeId) && roleOf(i) !== 'Artifact') close(); continue; }
      if (run.length && Math.abs(i.bbox[0] - run[0].bbox[0]) > 4) close();
      run.push(i);
    }
    close();
  }
}

/** "…including:" followed by aligned items in one style — run after tables, on what's left. */
function colonLists(frames: FrameState[], roleOf: (i: ItemState) => TextRole | undefined, used: Set<string>, lists: ListSuggestion[]) {
  for (const frame of frames) {
    const texts = frame.items.filter((i) => i.kind === 'text');
    // "…including:" followed by aligned items in one style.
    texts.forEach((intro, n) => {
      if (used.has(intro.nodeId) || !norm(intro.text).endsWith(':') || roleOf(intro) === 'Artifact') return;
      const after: ItemState[] = [];
      for (const next of texts.slice(n + 1)) {
        const r = roleOf(next);
        if (used.has(next.nodeId) || r === 'Artifact' || (r && /^H[1-6]$/.test(r))) break;
        if (after.length && (styleKey(next) !== styleKey(after[0]) || Math.abs(next.bbox[0] - after[0].bbox[0]) > 4)) break;
        if (words(next.text) > 40) break;
        after.push(next);
      }
      if (after.length >= 2) {
        lists.push({ id: `list:${after[0].nodeId}`, frameId: frame.id, items: after.map((i) => ({ body: [i.nodeId] })) });
        for (const i of after) used.add(i.nodeId);
      }
    });
  }
}
