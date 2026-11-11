/**
 * Finds "text that isn't text": words drawn as shapes.
 *
 * A screen reader gets nothing from a heading that was outlined (flattened to vectors) in Figma, or
 * from lettering drawn by hand. Found here, each one can be tagged as a Figure whose alt text is the
 * words. Logos and wordmarks are left alone: they are handled elsewhere.
 */

import type { ChartNode } from './charts.ts';

/** A layer tree node, plus the Figma node type when the caller knows it (VECTOR, GROUP…). */
export type OutlineNode = Omit<ChartNode, 'children'> & {
  type?: string;
  /** Absolutely positioned inside an auto-layout parent: taken out of the layout's flow on purpose. */
  abs?: boolean;
  /** Placed by hand: absolutely positioned, or inside a group or a frame without auto layout. */
  placed?: boolean;
  /** Huge text-free artwork folded into one block: about how many shapes it holds (not walked). */
  bulk?: number;
  children: OutlineNode[];
};

export interface OutlinedText {
  id: string;
  name: string;
  /** Frame coordinates, top-left origin. */
  box: { x: number; y: number; w: number; h: number };
  /** Suggested alt text (the words), when the layer name gives them. A person still approves it. */
  alt?: string;
  /** Why it was flagged, for the panel. */
  reason: string;
}

/** Brand marks: handled by the logo logic, never suggested from here. */
const LOGO = /(^|[^a-z])(logo|logos|logotype|logomark|wordmark|lockup|brandmark)([^a-z]|$)/i;
/** Icons: square-ish and named like a glyph. */
const ICON = /(^|[^a-z])(icon|icons|ic|ico|glyph|symbol|emoji)([^a-z]|$)/i;

/**
 * Words Figma (or designers) use to name shapes, not to say anything. A name made only of these
 * (and numbers) is a layer name, not outlined text: "Vector", "Group 12", "Arrow right", "Mask group".
 */
const GENERIC = new Set(
  (
    'vector union group rectangle rect ellipse circle oval line polygon star frame subtract intersect intersection exclude ' +
    'rule rules hairline keyline underline stripe ' +
    'mask path shape boolean flatten outline outlines stroke fill copy layer component instance variant property ' +
    'logo icon arrow chevron caret image img photo picture pic background bg pattern texture gradient overlay ' +
    'decoration deco divider separator border shadow glow blur noise grain container wrapper button btn badge tag ' +
    'chip avatar illustration graphic graphics art artwork element object ornament sparkle dot dots grid wave blob ' +
    'placeholder left right up down top bottom center middle close menu hamburger check checkmark tick plus minus x ' +
    'cross search play pause corner bracket base bar card box square triangle ring light dark small large big mobile ' +
    'desktop default hover active state slot spacer color white black blue red green yellow orange purple gray grey ' +
    'pink primary secondary new old final asset assets bullet number numbers vertical horizontal curve curves swoosh ' +
    'hero section header footer nav navigation content block row column col item list wrap inner outer main side panel ' +
    'chart graph map flag visual'
  ).split(' '),
);

/** Figma types that can be outlined text. Rectangles, ellipses and lines can't. */
const SHAPE_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON']);
// Frames are left out: they get descriptive names ("Hero visual") far more often than outlined words.
const GROUP_TYPES = new Set(['GROUP', 'BOOLEAN_OPERATION']);

const clean = (s: string) =>
  s
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '') // quotes kept from a pull quote's layer name
    .replace(/\s+copy(\s+\d+)?$/i, '') // Figma's old "… copy 2" duplicate suffix
    .trim();

/** Letter runs in a name: "Group 12" → ["group"], "Get started" → ["get", "started"]. */
const wordsOf = (s: string): string[] => [...s.toLowerCase().matchAll(/\p{L}+/gu)].map((m) => m[0]);
const singular = (w: string) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

/** True when a layer name reads like words someone wrote, not like a layer name. */
export function readsLikeWords(name: string): boolean {
  const s = clean(name);
  if (!s || LOGO.test(s) || ICON.test(s)) return false;
  // Variant props ("Type=Primary"), paths ("icons/arrow"), snake or colon ids ("material-symbols:home").
  if (/[=/\\]/.test(s) || (!s.includes(' ') && /[_:]/.test(s))) return false;
  const words = wordsOf(s);
  if (!words.length || words.every((w) => GENERIC.has(w) || GENERIC.has(singular(w)))) return false;
  // Hex ids, frame numbers and the like have few letters among many other characters.
  if (words.join('').length < s.replace(/\s/g, '').length / 2) return false;
  return words.length >= 2 || words[0].length >= 4;
}

const aspect = (b: OutlinedText['box']) => b.w / Math.max(b.h, 0.01);

function onlyShapes(n: OutlineNode): boolean {
  return n.kind === 'shape' ? !n.line : n.kind === 'container' && n.children.length > 0 && n.children.every(onlyShapes);
}

/** Can this node be a flattened text layer (or a group of them)? */
function shapeLike(n: OutlineNode): boolean {
  if (n.kind === 'shape') return !n.line && (!n.type || SHAPE_TYPES.has(n.type));
  // Instances are components (buttons, icons): their names describe the component, not its words.
  return n.kind === 'container' && (!n.type || GROUP_TYPES.has(n.type)) && onlyShapes(n);
}

/**
 * Hand-drawn or imported lettering: 3+ small shapes in a row, of similar height and varied width
 * (letters differ; dots, stars and bars are identical), with small gaps between them.
 */
function looksLikeLettering(n: OutlineNode): boolean {
  if (n.kind !== 'container' || n.children.length < 3) return false;
  const kids = n.children;
  if (!kids.every((c) => c.kind === 'shape' && !c.line && (!c.type || SHAPE_TYPES.has(c.type)))) return false;
  const hs = kids.map((c) => c.box.h).sort((a, b) => a - b);
  const mh = hs[Math.floor(hs.length / 2)];
  if (mh <= 0 || mh > 200) return false; // big shapes are artwork, not letters
  // Similar heights: most within 25% of the median, none wildly off (descenders, caps vs. lowercase).
  const near = kids.filter((c) => Math.abs(c.box.h - mh) <= 0.25 * mh).length;
  if (near < 0.6 * kids.length || kids.some((c) => c.box.h > 2.2 * mh || c.box.h < 0.3 * mh)) return false;
  // Letter-shaped: none much wider than tall.
  if (kids.some((c) => c.box.w > 1.6 * mh)) return false;
  // Varied widths: a row of identical shapes is a pattern (pagination dots, rating stars).
  const ws = kids.map((c) => c.box.w);
  if (Math.max(...ws) - Math.min(...ws) < 0.15 * Math.max(...ws)) return false;
  // In a row: sorted left to right, sharing a band, with small gaps (kerning to word spaces).
  const row = [...kids].sort((a, b) => a.box.x - b.box.x);
  const mid = (c: OutlineNode) => c.box.y + c.box.h / 2;
  const band = mid(row[0]);
  if (row.some((c) => Math.abs(mid(c) - band) > 0.6 * mh)) return false;
  for (let i = 1; i < row.length; i++) {
    const gap = row[i].box.x - (row[i - 1].box.x + row[i - 1].box.w);
    if (gap > 1.2 * mh || gap < -0.5 * row[i - 1].box.w) return false;
  }
  return aspect(n.box) >= 1.5;
}

/** Outermost layers that are words drawn as shapes. Hidden layers are expected to be gone already. */
export function findOutlinedText(root: OutlineNode | ChartNode): OutlinedText[] {
  const out: OutlinedText[] = [];
  const walk = (n: OutlineNode) => {
    if (n !== root && !LOGO.test(n.name) && !ICON.test(n.name)) {
      // Lettering has height; a hairline or rule (1px tall, page wide) never reads as words.
      if (shapeLike(n) && aspect(n.box) >= 1.5 && aspect(n.box) <= 40 && n.box.h >= 4 && readsLikeWords(n.name)) {
        out.push({ id: n.id, name: n.name, box: n.box, alt: clean(n.name), reason: `Shapes named "${clean(n.name)}": likely outlined text` });
        return;
      }
      if (looksLikeLettering(n)) {
        out.push({ id: n.id, name: n.name, box: n.box, reason: 'Letter-like shapes in a row: likely lettering; type the words as alt text' });
        return;
      }
    } else if (n !== root) return; // a logo or icon: none of its parts are outlined text either
    for (const c of n.children) walk(c);
  };
  walk(root as OutlineNode);
  return out;
}

/**
 * Image names that suggest words inside the picture ("Screen Shot 2024-…", "hero_banner",
 * "QuoteCard"), so the panel can ask for them in the alt text. Conservative on purpose.
 */
export function imageMayHaveText(name: string): boolean {
  const s = name
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase
    .replace(/(\p{L})(\d)/gu, '$1 $2') // "Screenshot2024"
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase();
  return /\b(screen\s*shots?|screen\s*grabs?|screengrabs?|quotes?|quotation|headlines?|infographics?|posters?|banners?|texts?|charts?|graphs?|diagrams?|tables?|slides?|testimonials?)\b/.test(s);
}
