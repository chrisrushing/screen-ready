/**
 * Finds diagrams: artwork with text labels laid over it.
 *
 * An illustration with callouts ("Login", "API", "Database"), a network drawing with
 * "Choke point" pinned to it: the labels are separate text layers, so a screen reader would read
 * the picture's alt text and then a list of loose words that only make sense on top of the
 * picture. Found here, the labels are read as part of the picture instead, and its alt text is
 * drafted to include them.
 *
 * The art is an image or graphic the panel already lists, or a container of shapes with no text
 * of its own. A label is short, small text whose box sits mostly on the art. Labels grouped
 * together (a "Labels" frame, a callout with a title and a subtitle) go together: a group made
 * only of labels that lies mostly on the art brings all of its text, even a few labels hanging
 * just off the edge. It takes 3 labels to make a diagram.
 *
 * Labels are placed by hand, never part of the page's layout flow (a headline or a footer that
 * happens to cross the art). Art that fills most of the page only takes labels taken out of an
 * auto layout on purpose, so a backdrop never swallows the page's text.
 */

import type { OutlineNode } from './outlined.ts';

type Box = OutlineNode['box'];

export interface Diagram {
  /** The art: an existing image or graphic item, or a container of shapes (created). */
  id: string;
  name: string;
  box: Box;
  /** True when the art isn't an item yet: a container of shapes found here. */
  created: boolean;
  /** Label text layers, in layer order. */
  labels: string[];
  /** The labels as they group in the layers (a callout's title and subtitle), in layer order. */
  units: string[][];
}

export interface DiagramOptions {
  /** Images and graphics already listed (frame coordinates). Decorative ones should be left out. */
  anchors: Array<{ id: string; name: string; box: Box }>;
  /** Text layers that could be a label: short, small, not already taken (a chart's label, a heading set by hand). */
  isLabel: (id: string) => boolean;
  /** Layers that are items already (images, logos, charts): never made into a new diagram's art. */
  taken: Set<string>;
}

const area = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h);
const clip = (b: Box, to: Box): Box => {
  const x = Math.max(b.x, to.x), y = Math.max(b.y, to.y);
  return { x, y, w: Math.min(b.x + b.w, to.x + to.w) - x, h: Math.min(b.y + b.h, to.y + to.h) - y };
};
const overlap = (a: Box, b: Box) => {
  const c = clip(a, b);
  return c.w > 0 && c.h > 0 ? c.w * c.h : 0;
};

export function findDiagrams(root: OutlineNode, opts: DiagramOptions): Diagram[] {
  const frameArea = area(root.box);
  const parent = new Map<OutlineNode, OutlineNode>();
  const texts = new Map<OutlineNode, OutlineNode[]>();
  const shapes = new Map<OutlineNode, number>();
  // Worked out once, bottom up: a map or a pattern can be thousands of layers.
  const onlyLabels = new Map<OutlineNode, boolean>();
  const holdsTaken = new Map<OutlineNode, boolean>();
  const index = (n: OutlineNode): void => {
    const t: OutlineNode[] = n.kind === 'text' ? [n] : [];
    let s = n.kind === 'shape' ? 1 : n.bulk ?? 0;
    let labels = n.kind === 'text' ? opts.isLabel(n.id) : true;
    let taken = opts.taken.has(n.id);
    for (const c of n.children) {
      parent.set(c, n);
      index(c);
      const ct = texts.get(c)!;
      for (let k = 0; k < ct.length; k++) t.push(ct[k]);
      s += shapes.get(c)!;
      labels &&= onlyLabels.get(c)!;
      taken ||= holdsTaken.get(c)!;
    }
    texts.set(n, t);
    shapes.set(n, s);
    onlyLabels.set(n, labels);
    holdsTaken.set(n, taken);
  };
  index(root);
  const allLabels = (n: OutlineNode) => onlyLabels.get(n)!;
  const candidates = texts.get(root)!.filter((t) => onlyLabels.get(t));

  const claimed = new Set<string>();
  const out: Diagram[] = [];
  const labelsOn = (art: { box: Box }): OutlineNode[] => {
    const box = clip(art.box, root.box);
    const artArea = area(box);
    if (artArea <= 0) return [];
    // Art covering most of the page is a backdrop as often as a picture: only labels placed on it
    // by hand (absolutely positioned, out of the page's layout) count, never the page's own text.
    const backdrop = artArea > frameArea * 0.75;
    const found: OutlineNode[] = [];
    for (const t of candidates) {
      if (claimed.has(t.id)) continue;
      // The outermost group of labels this text belongs to, no bigger than the art itself.
      let unit = t;
      let abs = !!t.abs, placed = !!t.placed;
      for (let p = parent.get(t); p && p !== root; p = parent.get(p)) {
        if (!allLabels(p) || area(clip(p.box, root.box)) > artArea * 1.5) break;
        unit = p;
        abs ||= !!p.abs;
        placed ||= !!p.placed;
      }
      // Text laid out in the page's flow is the page's own; on a backdrop, only text taken out of
      // the flow on purpose counts (in a page without auto layout, everything is placed by hand).
      if (!placed || (backdrop && !abs)) continue;
      const ub = clip(unit.box, root.box);
      // A strip across the page (a header, a footer) isn't on the art, even where it crosses it.
      const fb = root.box;
      if ((ub.w > box.w * 1.2 && ub.w >= fb.w * 0.8) || (ub.h > box.h * 1.2 && ub.h >= fb.h * 0.8)) continue;
      const own = area(ub);
      const on = own > 0 ? overlap(ub, box) / own : centerIn(t.box, box) ? 1 : 0;
      if (on >= 0.5) found.push(t);
    }
    return found;
  };
  const record = (art: { id: string; name: string; box: Box }, created: boolean, labels: OutlineNode[]) => {
    for (const l of labels) claimed.add(l.id);
    // Units: labels sharing a direct parent that holds nothing but these few labels (a callout).
    const units: string[][] = [];
    const seen = new Map<OutlineNode, string[]>();
    for (const l of labels) {
      const p = parent.get(l);
      const siblings = p && p !== root ? texts.get(p)! : [];
      if (p && siblings.length > 1 && siblings.length <= 3 && siblings.every((s) => labels.includes(s))) {
        const u = seen.get(p);
        if (u) { u.push(l.id); continue; }
        const fresh = [l.id];
        seen.set(p, fresh);
        units.push(fresh);
      } else units.push([l.id]);
    }
    out.push({ id: art.id, name: art.name, box: art.box, created, labels: labels.map((l) => l.id), units });
  };

  // Pictures the panel already lists come first: their labels are theirs.
  for (const a of [...opts.anchors].sort((x, y) => area(x.box) - area(y.box))) {
    const labels = labelsOn(a);
    if (labels.length >= 3) record(a, false, labels);
  }

  // Then drawings made of shapes: the outermost container with shapes and no text that isn't (and
  // doesn't hold) a listed item. Inside one that has no labels, only a backdrop is looked into
  // further (the picture may be a part of it); the rest is the drawing's own detail. Small
  // containers are never pictures, and nothing inside them is either.
  if (!candidates.length) return out;
  let budget = 200;
  const visit = (n: OutlineNode) => {
    for (const c of n.children) {
      if (c.kind !== 'container' || budget <= 0) continue;
      const a = area(clip(c.box, root.box));
      if (a < frameArea * 0.03) continue;
      if (texts.get(c)!.length || holdsTaken.get(c)) { visit(c); continue; }
      if (shapes.get(c)! < 4) continue;
      budget--;
      const labels = labelsOn(c);
      if (labels.length >= 3) record({ id: c.id, name: c.name, box: c.box }, true, labels);
      else if (a > frameArea * 0.75) visit(c);
    }
  };
  visit(root);
  return out;
}

function centerIn(b: Box, r: Box) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}

/** "Labels: Login, API, Database; 01 · Login: Single sign-on." — the labels, as a sentence to append. */
export function labelsSentence(units: string[][], textOf: (id: string) => string): string {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '');
  const parts = units.map((u) => u.map((id) => clean(textOf(id))).filter(Boolean).join(': ')).filter(Boolean);
  const sep = units.some((u) => u.length > 1) ? '; ' : ', ';
  return parts.length ? `Labels: ${parts.join(sep)}.` : '';
}

/** True when the alt text already names most of the labels: nothing to add. */
export function altCoversLabels(alt: string, labels: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const a = ` ${norm(alt)} `;
  const named = labels.map(norm).filter(Boolean);
  return named.length > 0 && named.filter((l) => a.includes(` ${l} `)).length >= Math.ceil(named.length / 2);
}
