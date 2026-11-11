/**
 * Suggests a role for every text layer the designer hasn't set by hand.
 *
 * Headings come from the document's type scale, not from one frame at a time: the same visual
 * style should be the same kind of heading on every page, because screen-reader users navigate by
 * heading level ("next H2"). So:
 *
 *   1. Per layer, first: a text style named like a heading or body wins; characters drawn as a
 *      pattern, symbols alone, running headers/footers and page numbers are decorative; other
 *      numbers (stat callouts) and long text are Text.
 *   2. Across the whole document, each remaining style (family, size, weight, italic, caps) is a
 *      heading style if it is bigger than body text — or as big and bolder — short, and used a
 *      few times per frame at most (more than that is a list or a table).
 *   3. Heading styles are ranked by prominence into tiers, document-wide.
 *   4. Levels follow roles: a top style used on a single frame is the document title (H1); on each
 *      frame the highest tier present is the page title (H2, or H1 without a document title), and
 *      lower tiers on that frame follow in order (H3, H4…). Levels therefore never skip.
 *   5. A frame left with no heading gets its bold label near the top as its page title.
 *
 * These are suggestions: the panel marks them as such, and any change the designer makes wins.
 */
import type { TextRole } from './types.ts';
import { imageMayHaveText } from './outlined.ts';
import type { FrameState, ItemState } from './messages.ts';

export interface Suggestion {
  role: TextRole;
  /** Shown as a tooltip, so the designer can see why. */
  reason: string;
}

const norm = (s = '') => s.replace(/\s+/g, ' ').trim();
const wordCount = (s: string) => norm(s).split(' ').filter(Boolean).length;
const size = (i: ItemState) => i.fontSize ?? 0;
const weight = (i: ItemState) => i.fontWeight ?? 400;
/** Letters in any script (Latin, CJK, Arabic…). Emoji, arrows and icon-font glyphs aren't. */
const hasLetter = (s: string) => /\p{L}/u.test(s);
/** Icon fonts draw pictures from text: "arrow_forward" in Material Icons is an arrow, not words. */
const ICON_FONT = /material (icons|symbols)|font ?awesome|phosphor|feather|lucide|ionicons|remix ?icon|tabler|bootstrap icons|glyphicons|icomoon|fontello|heroicons|octicons|symbols? (sharp|rounded|outlined)|segoe (mdl2|fluent) (assets|icons)|sf symbols|apple color emoji|noto color emoji/i;
const hasDigit = (s: string) => /\d/.test(s);
/** A value rather than words: "$120K", "64 %", "4x", "FY2024", "$137K vs $99K". */
const MAGNITUDE = /^[\s$€£¥~≈<>+±-]*\d[\d.,]*\s*(%|x|×|k|m|bn?|t|thousand|million|billion|trillion|plus|times)?\+?[\s.]*$/i;
const statLike = (s: string) => {
  if (MAGNITUDE.test(s)) return true;
  const letters = [...s].filter((c) => c.toLowerCase() !== c.toUpperCase()).length;
  const digits = (s.match(/\d/g) ?? []).length;
  return digits > 0 && letters / (letters + digits) <= 0.5;
};

const HEADING_STYLE = /(?:^|[^a-z])h([1-6])(?![0-9])|heading\s*[-_/ ]?\s*([1-6])/i;
const BODY_STYLE = /body|paragraph|caption|footnote|label|legal|small|meta/i;

/** Within the top or bottom 8% of the frame. bbox is in PDF points, origin bottom-left. */
const nearEdge = (frame: FrameState, i: ItemState, band = 0.08) => {
  const H = frame.height || 1;
  return i.bbox[1] / H <= band || (H - i.bbox[3]) / H <= band;
};

/** The visual style of a text layer: what "the same kind of text" means across frames. */
const styleKey = (i: ItemState) =>
  `${i.fontFamily ?? '?'}|${Math.round(size(i))}|${weight(i)}|${i.italic ? 'i' : ''}|${i.upper ? 'U' : ''}`;
const describe = (i: ItemState) =>
  `${i.fontFamily ?? 'Text'} ${weight(i) >= 600 ? 'bold ' : ''}${i.italic ? 'italic ' : ''}${Math.round(size(i))}pt`;

export function suggestRoles(frames: FrameState[]): Map<string, Suggestion> {
  const out = new Map<string, Suggestion>();
  const all = frames.flatMap((f) => f.items.filter((i) => i.kind === 'text').map((i) => ({ f, i })));
  if (!all.length) return out;
  const set = (i: ItemState, role: TextRole, reason: string) => out.set(i.nodeId, { role, reason });

  // Body text: the size carrying the most characters, and its usual weight.
  const charsBySize = new Map<number, number>();
  for (const { i } of all) charsBySize.set(Math.round(size(i)), (charsBySize.get(Math.round(size(i))) ?? 0) + norm(i.text).length);
  const body = [...charsBySize.entries()].sort((a, b) => b[1] - a[1])[0][0] || 16;
  const bodyWeights = all.filter(({ i }) => Math.round(size(i)) === body).map(({ i }) => weight(i)).sort((a, b) => a - b);
  const bodyWeight = bodyWeights[Math.floor(bodyWeights.length / 2)] ?? 400;

  // Characters drawn as a pattern: a group of 20+ text layers that are mostly not words.
  const byParent = new Map<string, ItemState[]>();
  for (const { i } of all) if (i.parentId) byParent.set(i.parentId, [...(byParent.get(i.parentId) ?? []), i]);
  const patternParents = new Set(
    [...byParent.entries()]
      .filter(([, xs]) => xs.length >= 20 && xs.filter((x) => !hasLetter(norm(x.text))).length / xs.length >= 0.8)
      .map(([id]) => id),
  );

  // The same text in the same spot on another frame is a running header or footer. Position
  // matters: a ToC's "01" and a page number "01" are the same text but not the same thing.
  const NEAR = 8;
  const key = new Map(all.map(({ i }) => [i, norm(i.text).toLowerCase()]));
  const sameText = new Map<string, Array<{ f: FrameState; i: ItemState }>>();
  for (const x of all) sameText.set(key.get(x.i)!, [...(sameText.get(key.get(x.i)!) ?? []), x]);
  const repeatCount = (frame: FrameState, i: ItemState) =>
    new Set((sameText.get(key.get(i)!) ?? []).filter(({ f, i: j }) =>
      f !== frame &&
      (Math.abs(j.bbox[0] - i.bbox[0]) <= NEAR || Math.abs(j.bbox[2] - i.bbox[2]) <= NEAR ||
        // Facing pages: the footer swaps sides, mirrored across the page.
        Math.abs(j.bbox[0] - ((f.width || 0) - i.bbox[2])) <= NEAR) &&
      Math.abs(j.bbox[3] - i.bbox[3]) <= NEAR,
    ).map(({ f }) => f)).size;
  // Running headers and footers sit in the top or bottom band. Mid-page, the same words in the
  // same spot are usually the same layout reused ("01" in a list on two pages) — only words that
  // repeat on three or more other frames count there.
  const repeats = (frame: FrameState, i: ItemState) => {
    const n = repeatCount(frame, i);
    return n > 0 && (nearEdge(frame, i, 0.12) || (hasLetter(norm(i.text)) && n >= 3));
  };

  // Text stacked on a layer that already says the same thing (a styling trick: a second layer for a
  // color or outline effect) would be read twice. The contained copy is decorative.
  const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const inter = (a: number[], b: number[]) =>
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const duplicates = new Set<string>();
  for (const f of frames) {
    const words = f.items.filter((i) => i.kind === 'text' && hasLetter(norm(i.text)) && norm(i.text).length >= 3);
    const at = new Map(words.map((w, k) => [w, k]));
    for (const a of words)
      for (const b of words) {
        if (a === b || duplicates.has(a.nodeId) || !inter(a.bbox, b.bbox)) continue;
        const ta = key.get(a)!, tb = key.get(b)!;
        if (!ta.includes(tb) || (ta === tb && at.get(b)! < at.get(a)!)) continue;
        if (inter(a.bbox, b.bbox) >= 0.8 * Math.min(area(a.bbox), area(b.bbox))) duplicates.add(b.nodeId);
      }
  }

  // ---- 1. Per-layer rules ----
  const open: Array<{ f: FrameState; i: ItemState }> = [];
  for (const { f, i } of all) {
    const t = norm(i.text);
    if (duplicates.has(i.nodeId)) { set(i, 'Artifact', 'Overlaps another layer with the same text — it would be read twice'); continue; }
    if (i.inChart) { set(i, 'P', 'Part of a chart — skipped once the chart has alt text'); continue; }
    if (ICON_FONT.test(i.fontFamily ?? '')) { set(i, 'Artifact', `An icon drawn with a font (${i.fontFamily}) — a picture, not words`); continue; }
    if (i.colorAlpha === 0) { set(i, 'Artifact', 'Invisible (no fill, or 0% opacity) — nobody sees it, so it isn’t read'); continue; }
    if (i.clipped) { set(i, 'Artifact', 'Cropped out of view by its frame — not on the page, so it isn’t read'); continue; }
    if (i.bbox[2] <= 0 || i.bbox[0] >= (f.width || Infinity) || i.bbox[3] <= 0 || i.bbox[1] >= (f.height || Infinity)) {
      set(i, 'Artifact', 'Outside the frame — cropped off the page'); continue;
    }
    const style = i.styleName ?? '';
    const level = HEADING_STYLE.exec(style);
    // Running headers, footers and page numbers first: a footer set in a "Label" or "Caption"
    // style is still a footer. Where it sits says more than what its style is called.
    if (i.parentId && patternParents.has(i.parentId) && !hasLetter(t)) set(i, 'Artifact', 'Part of a pattern drawn with characters');
    else if (!hasLetter(t) && !hasDigit(t)) set(i, 'Artifact', 'Symbols only, like an arrow or a bullet');
    // A letter or two on their own ("T" as a drop cap, "K" after a number) is a piece of the
    // text beside it, never a title — however big it's set.
    else if (t.replace(/\s/g, '').length <= 2 && hasLetter(t) && !level) set(i, 'P', 'One or two letters on their own — part of the text beside it, not a heading');
    else if (repeats(f, i)) set(i, 'Artifact', 'Repeats in the same spot on several frames, like a footer');
    else if (!hasLetter(t) && nearEdge(f, i) && size(i) <= body) set(i, 'Artifact', 'A number at the page edge, like a page number');
    else if (level) set(i, `H${level[1] ?? level[2]}` as TextRole, `Text style “${style}”`);
    else if (style && BODY_STYLE.test(style)) set(i, 'P', `Text style “${style}”`);
    else if (!hasLetter(t) || statLike(t)) set(i, 'P', 'Numbers, like a stat or a figure');
    else if (t.length > 120) set(i, 'P', 'Long text');
    else open.push({ f, i });
  }

  // ---- 2. Heading styles, judged across the whole document ----
  // Judge each style on every use that reads as words — long paragraphs included. Judging only the
  // short leftovers would make a bold-paragraph style look like a heading style.
  const styles = new Map<string, { items: Array<{ f: FrameState; i: ItemState }>; frames: Set<FrameState> }>();
  for (const x of all.filter(({ i }) => hasLetter(norm(i.text)) && !statLike(norm(i.text)) && !duplicates.has(i.nodeId))) {
    const k = styleKey(x.i);
    const st = styles.get(k) ?? { items: [], frames: new Set() };
    st.items.push(x);
    st.frames.add(x.f);
    styles.set(k, st);
  }
  const headingStyles = new Map<string, number>(); // style → prominence
  for (const [k, st] of styles) {
    const sample = st.items[0].i;
    const words = st.items.map(({ i }) => wordCount(i.text ?? '')).sort((a, b) => a - b);
    const medWords = words[Math.floor(words.length / 2)];
    const perFrame = st.items.length / st.frames.size;
    const bigger = size(sample) >= body * 1.15;
    // Bold, or a step heavier than body (Medium over Regular) for a short line: a subhead set at body size.
    const bolder = size(sample) >= body * 0.95 && weight(sample) > bodyWeight &&
      (weight(sample) >= 600 || (weight(sample) >= 500 && weight(sample) >= bodyWeight + 100 && medWords <= 8));
    const smallCaps = !!sample.upper && size(sample) < body * 1.5; // eyebrows, labels, dates
    if ((bigger || bolder) && medWords <= 12 && perFrame <= 4 && !smallCaps) {
      headingStyles.set(k, size(sample) * (weight(sample) >= 600 ? 1.12 : 1));
    } else {
      const why =
        perFrame > 4 && (bigger || bolder) ? 'Looks like a list or table — many of these per frame'
        : smallCaps ? 'Small all-caps text, like a label or a date'
        : medWords > 12 && (bigger || bolder) ? `${describe(sample)} is mostly used for paragraphs`
        : `Body size (${Math.round(size(sample))}pt)`;
      for (const { i } of st.items) if (!out.has(i.nodeId)) set(i, 'P', why);
    }
  }

  // A single giant word dwarfing the next heading style on its frame is a wordmark, not a title.
  for (const f of frames) {
    const mine = open.filter((x) => x.f === f && headingStyles.has(styleKey(x.i)) && !out.has(x.i.nodeId)).sort((a, b) => size(b.i) - size(a.i));
    if (mine.length > 1 && wordCount(mine[0].i.text ?? '') === 1 && size(mine[0].i) >= 3 * size(mine[1].i)) {
      set(mine[0].i, 'Artifact', 'A giant single word behind the content, like a wordmark');
    }
  }

  // ---- 3. Tiers: heading styles of similar prominence share a tier, document-wide ----
  // Only styles that still have headings after the rules above (a wordmark's style may not).
  const live = new Set(open.filter(({ i }) => !out.has(i.nodeId)).map(({ i }) => styleKey(i)));
  const ranked = [...headingStyles.entries()].filter(([k]) => live.has(k)).sort((a, b) => b[1] - a[1]);
  const tierOf = new Map<string, number>();
  let tier = -1;
  let top = Infinity;
  for (const [k, p] of ranked) {
    if (p < top * 0.88) { tier++; top = p; }
    tierOf.set(k, tier);
  }

  // A short bold line directly followed by a longer, regular paragraph at the same size is a run-in
  // heading ("Political Uncertainty", an FAQ question), even when its style is also used for bold
  // paragraphs elsewhere. These form the lowest tier.
  const runIn = new Set<string>();
  const openSet = new Set(open.map((x) => x.i));
  for (const f of frames) {
    const texts = f.items.filter((i) => i.kind === 'text');
    texts.forEach((i, k) => {
      const next = texts[k + 1];
      if (!next || headingStyles.has(styleKey(i)) || out.get(i.nodeId)?.role === 'Artifact') return;
      if (!openSet.has(i)) return;
      const t = norm(i.text);
      const shouting = t === t.toUpperCase(); // "JULY TO SEPTEMBER": a label, not a heading
      const maxWords = t.endsWith('?') ? 16 : 10; // questions run longer than titles
      if (weight(i) >= 600 && wordCount(t) <= maxWords && !/[.]$/.test(t) && !shouting && size(i) >= body * 0.7 &&
          Math.abs(size(next) - size(i)) <= 1 && weight(next) < 600 && !next.italic && wordCount(next.text ?? '') >= 12) {
        runIn.add(i.nodeId);
      }
    });
  }
  const runInTier = tier + 1;

  // ---- 4. Levels by role ----
  const tierOfItem = (i: ItemState) => (runIn.has(i.nodeId) ? runInTier : tierOf.get(styleKey(i)));
  const headingItems = open.filter(({ i }) => (headingStyles.has(styleKey(i)) || runIn.has(i.nodeId)) && out.get(i.nodeId)?.role !== 'Artifact');
  const tierFrames = new Map<number | undefined, Set<FrameState>>();
  for (const { f, i } of headingItems) {
    const t = tierOfItem(i);
    if (!tierFrames.has(t)) tierFrames.set(t, new Set());
    tierFrames.get(t)!.add(f);
  }
  const framesWithTier = (t: number) => tierFrames.get(t) ?? new Set<FrameState>();
  const headingsByFrame = new Map<FrameState, typeof headingItems>();
  for (const x of headingItems) headingsByFrame.set(x.f, [...(headingsByFrame.get(x.f) ?? []), x]);
  const docTitle = frames.length > 1 && ranked.length > 1 && framesWithTier(0).size === 1 ? 0 : -1;
  const base = docTitle === 0 ? 2 : 1;
  for (const f of frames) {
    const mine = headingsByFrame.get(f) ?? [];
    const tiers = [...new Set(mine.map(({ i }) => tierOfItem(i)!))].filter((t) => t !== docTitle).sort((a, b) => a - b);
    for (const { i } of mine) {
      const t = tierOfItem(i)!;
      if (t === docTitle) { set(i, 'H1', 'Document title — the largest heading style, used once'); continue; }
      const rank = tiers.indexOf(t);
      const lvl = Math.min(6, base + rank);
      const uses = framesWithTier(t).size;
      set(i, `H${lvl}` as TextRole,
        runIn.has(i.nodeId) && rank > 0 ? 'Short bold line leading into a paragraph — a run-in heading'
        : rank === 0 ? `Page title — the largest heading style on this frame (${describe(i)})`
        : `Heading — ${describe(i)} is used as a heading on ${uses} frame${uses === 1 ? '' : 's'}`);
    }
  }

  // ---- 5. A frame with no heading: its bold label near the top is the page title ----
  for (const frame of frames) {
    const texts = frame.items.filter((i) => i.kind === 'text');
    if (texts.some((i) => out.get(i.nodeId)?.role.startsWith('H'))) continue;
    const H = frame.height || 1;
    const label = texts
      .filter((i) => out.get(i.nodeId)?.reason.startsWith('Body size'))
      .filter((i) => weight(i) >= 600 && wordCount(i.text ?? '') <= 8 && (H - i.bbox[3]) / H <= 0.3)
      .sort((a, b) => b.bbox[3] - a.bbox[3])[0];
    if (label) set(label, `H${base}` as TextRole, 'Bold label at the top of a frame with no other heading');
  }

  // ---- 6. Still no heading: the frame's biggest line of text is its title ----
  // A cover or divider often has one huge headline in a style used nowhere else, so the scale
  // above never calls it a heading. Every page needs one to be jumped to; the obvious pick is the
  // largest short text, when it clearly stands out from the body size.
  for (const frame of frames) {
    const texts = frame.items.filter((i) => i.kind === 'text');
    if (texts.some((i) => out.get(i.nodeId)?.role.startsWith('H'))) continue;
    const title = texts
      .filter((i) => out.get(i.nodeId)?.role !== 'Artifact' && !i.inChart && hasLetter(norm(i.text)) && wordCount(i.text ?? '') <= 20)
      .sort((a, b) => size(b) - size(a))[0];
    if (title && size(title) >= body * 1.3) set(title, `H${base}` as TextRole, `Page title — the largest text on a frame with no other heading (${describe(title)})`);
  }
  return out;
}

// =============================================================================================
// Images and logos
// =============================================================================================

export interface ImageSuggestion {
  decorative: boolean;
  /** Suggested alt text: a logo's brand, or the words of a layer name a person chose. */
  alt?: string;
  reason: string;
  /** The alt text is a first draft (from the layer name): a person still checks it. */
  draft?: boolean;
}

/**
 * A layer name a person chose, as a first draft of alt text: "china 2" → "China",
 * "Art · Breach tower" → "Breach tower", "maps/team-photo" → "Team photo". Numbers Figma or the
 * designer added to tell copies apart, and a leading "Image ·" kind of word, are dropped.
 */
export function altFromName(name = ''): string {
  let s = (name.split('/').pop() ?? '').trim();
  s = s.replace(/^(art|artwork|image|img|photo|picture|pic|illustration|graphic|visual|figure)\s*[·•|:—–-]\s*/i, '');
  s = s.replace(/_+/g, ' ').replace(/\s+copy(\s+\d+)?$/i, '').replace(/(\s*[-#(]?\s*\d+\)?)+$/, '');
  if (!s.includes(' ')) s = s.replace(/-+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim().replace(/^(an?\s+)?(image|photo|picture|graphic|illustration|drawing)\s+of\s+/i, '');
  // Only words about the layout ("hero image", "card thumbnail") say nothing about the picture.
  const layout = /^(hero|banner|header|cover|card|thumb|thumbnail|placeholder|main|feature|featured|side|top|bottom|image|img|photo|picture|graphic|visual|art|artwork|illustration|media|asset|bg|background|section|block)$/i;
  if (!/\p{L}{2}/u.test(s) || isGeneric(s) || s.split(' ').every((w) => layout.test(w))) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const LOGO = /(^|[^a-z])(logo|logos|logotype|logomark|wordmark|lockup|brandmark)([^a-z]|$)/i;
const isLogo = (name = '') => LOGO.test(name) && !/no[\s_-]*logo/i.test(name);

/** Names Figma or a file system gave the layer — they say nothing about what it shows. */
const GENERIC = /^(rectangle|image|frame|group|vector|ellipse|polygon|star|line|union|subtract|intersect|exclude|mask group|clip path group|layer|untitled|img|pic|picture|photo|page\s*\d*|slide\s*\d*)\s*\d*(\s+\d+)?$/i;
const FILE_NAME = /^[\w\s().-]*\.(jpe?g|png|gif|webp|svg|heic|tiff?)(\s+\d+)?$/i;
const isGeneric = (name: string) => GENERIC.test(name.trim()) || FILE_NAME.test(name.trim()) || /^[\d\s_.-]*$/.test(name);

const DECORATIVE_NAME = /(texture|background|(^|[^a-z])bg([^a-z]|$)|pattern|noise|grain|gradient|overlay|ornament|decor|divider|swirl|blob|shadow|glow|blur|backdrop|wallpaper|bokeh|squiggle|flourish)/i;
const BLEND_LIKE_TEXTURE = new Set(['MULTIPLY', 'SCREEN', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'COLOR_BURN', 'COLOR_DODGE', 'DARKEN', 'LIGHTEN', 'LUMINOSITY']);

/**
 * "Acme Logo" → "Acme"; "SO-Logo-Lockup" → "SO"; "logo" → "". Component paths keep their
 * last named part: "wf/Logo · Globex" → "Globex", "Brand/Acme/logo" → "Acme".
 */
export function brandOf(name = ''): string {
  const parts = name.split('/').map(brandPart).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
function brandPart(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\b(logos?|logotype|logomark|wordmark|lockup|brandmark|color|colour|white|black|mono|dark|light|primary|secondary|horizontal|vertical|stacked|full|icon|symbol|mark|reversed|knockout|v\d+)\b/gi, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s·•|:—–-]+|[\s·•|:—–-]+$/g, '');
}

const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const near = (a: number[], b: number[], d: number) => a.every((v, i) => Math.abs(v - b[i]) <= d);

/**
 * Suggests decorative vs meaningful for every image and logo the designer hasn't decided on.
 * Strongest signal first:
 *   1. Named like a logo → meaningful, alt "<Brand> logo" — unless it repeats in the same spot on
 *      several frames, like a footer logo, which is decorative.
 *   2. The same graphic in the same spot on several frames → decorative.
 *   3. Named like decoration (texture, background, pattern…) → decorative.
 *   4. Stacked under another image in exactly the same spot → decorative (one of them is enough).
 *   5. A name a person chose ("india 2", "team photo") → meaningful, its words drafted as alt text
 *      ("India") for a person to check.
 *   6. Generic name and blended into the design (multiply, screen…), covering most of the frame,
 *      bleeding past its edges, or sitting behind text → decorative. Text on top of a generically
 *      named image (a stat card, a hero) carries the meaning; the image is backdrop.
 * Anything else gets no suggestion, and the panel asks for alt text.
 */
export function suggestImages(frames: FrameState[]): Map<string, ImageSuggestion> {
  const out = new Map<string, ImageSuggestion>();
  const all = frames.flatMap((f) => f.items.filter((i) => i.kind === 'image').map((i) => ({ f, i })));

  // A brand for generically named logos ("logo"), borrowed from the file's named ones.
  const brands = new Map<string, number>();
  for (const { i } of all) {
    for (const n of [i.componentName, i.name]) {
      if (!isLogo(n)) continue;
      const b = brandOf(n);
      if (b) brands.set(b, (brands.get(b) ?? 0) + 1);
    }
  }
  const fileBrand = [...brands.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  for (const frame of frames) {
    const frameArea = (frame.width || 1) * (frame.height || 1);
    const images = frame.items.filter((i) => i.kind === 'image');
    const texts = frame.items.filter((i) => i.kind === 'text');

    images.forEach((img, index) => {
      if (img.decided) return;
      const set = (decorative: boolean, reason: string, alt?: string, draft?: boolean) => out.set(img.nodeId, { decorative, reason, alt, draft });
      const repeats = all.some(({ f, i }) => f !== frame && i.signature && i.signature === img.signature && near(i.bbox, img.bbox, 8));

      if (img.chart) return set(false, 'Looks like a chart — say what it shows and the numbers that matter');
      if (isLogo(img.name) || isLogo(img.componentName)) {
        if (repeats) return set(true, 'A logo repeated in the same spot on several frames, like a footer');
        const brand = brandOf(img.componentName) || brandOf(img.name) || fileBrand;
        return set(false, 'Looks like a logo', brand ? `${brand} logo` : undefined);
      }
      if (repeats) return set(true, 'Repeats in the same spot on several frames');
      if (img.outlined !== undefined)
        return set(false, 'Words turned into shapes — screen readers only get them from the alt text', img.outlined || undefined);
      if (DECORATIVE_NAME.test(img.name)) return set(true, `Named like decoration (“${img.name}”)`);
      const stackedUnder = images.slice(index + 1).some((other) => near(other.bbox, img.bbox, 2));
      if (stackedUnder) return set(true, 'Stacked under another image in the same spot');
      if (imageMayHaveText(img.name)) return set(false, 'May have words in it — put them in the alt text');
      // A name a person chose ("china 2", "team photo"): probably content, and its words are a
      // good first draft of the alt text, for a person to check.
      if (!isGeneric(img.name)) {
        const alt = altFromName(img.name);
        return alt ? set(false, 'From its layer name — check it says what the image shows', alt, true) : undefined;
      }

      const coverage = area(img.bbox) / frameArea;
      const textOnTop = texts.some((t) => {
        const cx = (t.bbox[0] + t.bbox[2]) / 2, cy = (t.bbox[1] + t.bbox[3]) / 2;
        return cx >= img.bbox[0] && cx <= img.bbox[2] && cy >= img.bbox[1] && cy <= img.bbox[3];
      });
      if (img.blend && BLEND_LIKE_TEXTURE.has(img.blend)) return set(true, 'Blended into the design, like a texture');
      if (coverage >= 0.5 || img.bleeds) return set(true, 'Covers most of the frame, like a background');
      if (textOnTop) return set(true, 'Text sits on top of it, like a background');
    });
  }
  return out;
}

/**
 * An export must start at H1 (PDF/UA), but a selection from the middle of a document starts at an
 * H2 page title. So for the frames being exported:
 *   1. shift suggested levels up by the highest level present, so the page title becomes H1 and the
 *      levels under it keep their spacing;
 *   2. a suggested heading that still comes before the first H1 in reading order — a small label
 *      above the title, like "01 — The Basics" — becomes text.
 * Levels the designer set by hand are left alone (the checklist flags them if they break the rule).
 */
export function shiftToH1(frames: FrameState[], roles: Map<string, Suggestion>) {
  const items = frames.flatMap((f) => f.items).filter((it) => it.kind === 'text');
  const levelOf = (it: ItemState) => {
    const role = it.roleSet ? it.role : roles.get(it.nodeId)?.role;
    return role && /^H[1-6]$/.test(role) ? Number(role[1]) : 0;
  };
  const suggested = (it: ItemState) => !it.roleSet && /^H[1-6]$/.test(roles.get(it.nodeId)?.role ?? '');

  const top = Math.min(...items.map(levelOf).filter((l) => l > 0), 7);
  const by = top <= 6 ? top - 1 : 0;
  if (by > 0) {
    for (const it of items.filter(suggested)) {
      const s = roles.get(it.nodeId)!;
      s.role = `H${Math.max(1, Number(s.role[1]) - by)}` as TextRole;
      s.reason += ` (moved up ${by} level${by === 1 ? '' : 's'} so this export starts at H1)`;
    }
  }
  // The export must open with H1. Find the first heading in reading order: if it isn't H1, the
  // first page's title (its top-level heading) becomes H1, and only small labels sitting above that
  // title on the same page become text. Headings on other pages are never touched.
  const first = items.find((it) => levelOf(it) > 0);
  if (!first || levelOf(first) === 1) return;
  const frame = frames.find((f) => f.items.includes(first))!;
  const onPage = frame.items.filter((it) => it.kind === 'text' && levelOf(it) > 0);
  const title = onPage.reduce((a, b) => (levelOf(b) < levelOf(a) ? b : a));
  if (!suggested(title)) return; // set by hand: the checklist flags it instead
  const s = roles.get(title.nodeId)!;
  s.role = 'H1';
  s.reason = 'Page title of the first page — H1, so this export starts at H1';
  for (const it of onPage) {
    if (it === title) break;
    // Only smaller labels: a headline bigger than the "title" is no label above it.
    if (suggested(it) && (it.fontSize ?? 0) < (title.fontSize ?? 0)) {
      const r = roles.get(it.nodeId)!;
      r.role = 'P';
      r.reason = 'A label above the page title — read as text so this export starts at H1';
    }
  }
}

/**
 * A chart's title sits under the section it belongs to: "Ranking of Top Employers" set in the
 * same style as "Top Employers" above it would otherwise be a sibling section in the outline. The
 * heading right before a chart (a subtitle or two may sit between) moves one level down when an
 * earlier heading on the page is at its level or above. Roles set by hand are left alone.
 */
export function nestChartTitles(frames: FrameState[]) {
  const level = (i: ItemState) => (i.kind === 'text' && /^H[1-6]$/.test(i.role ?? '') ? Number(i.role![1]) : 0);
  for (const f of frames) {
    f.items.forEach((it, k) => {
      if (!it.chart) return;
      let title: ItemState | undefined;
      for (let j = k - 1, texts = 0; j >= 0 && texts < 3; j--) {
        const x = f.items[j];
        if (x.kind !== 'text' || x.inChart || x.role === 'Artifact') continue;
        texts++;
        if (level(x)) { title = x; break; }
      }
      if (!title || title.roleSet) return;
      const at = f.items.indexOf(title);
      const lvl = level(title);
      // The section it sits in: the nearest heading before it. One level under that, never deeper.
      const section = f.items.slice(0, at).reverse().find((x) => level(x) > 0);
      if (section && level(section) >= lvl && level(section) < 6) {
        title.role = `H${level(section) + 1}` as TextRole;
        title.reason = 'A chart’s title — one level under the section it sits in';
      }
    });
  }
}

