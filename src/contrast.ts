/**
 * WCAG 2.x text contrast, measured on a rendered frame.
 *
 * Runs in the UI iframe: the frame is exported as a PNG, a canvas decodes it, and the RGBA bytes
 * come here. Nothing in this module touches the DOM or the Figma API, so it runs (and is tested)
 * in Node. Port of tools/contrast.py, which was checked against real files.
 *
 * Text color comes from the layer's fill, not from the pixels: glyph strokes are thin and
 * anti-aliased, so few of their pixels show the true color. The background is what is left in the
 * text's box once the glyphs (and their soft edges) are taken out.
 */

export type RGB = [number, number, number];

export interface ContrastInput {
  id: string;
  /** In frame pixels, origin top-left. */
  box: { x: number; y: number; w: number; h: number };
  /** The text fill, 0–255 per channel. */
  color: RGB;
  /** Effective opacity of the text (fill opacity × layer opacity), 0–1. Default 1. */
  alpha?: number;
  /** In px (Figma px = CSS px). */
  fontSize: number;
  fontWeight: number;
}

/** Why a text could not be measured. */
export type ContrastUnknown =
  | 'empty' //      zero-size box
  | 'off-render' // box lies outside the rendered image
  | 'invisible' //  text opacity is 0
  | 'covered'; //   too few background pixels left once the glyphs are removed

export interface ContrastResult {
  id: string;
  /** Contrast ratio (1–21) against the worst background, or null when unknown. */
  ratio: number | null;
  /** AA minimum for this text: 4.5, or 3 for large text. */
  required: number;
  /** Large text by WCAG: ≥ 24px, or ≥ 18.66px at weight ≥ 700. */
  large: boolean;
  /** ratio ≥ required; null when unknown. */
  pass: boolean | null;
  /** The background color the ratio was measured against (the worst one when mixed). */
  background: RGB | null;
  /** The text color as seen: the fill, blended over the background when alpha < 1. */
  foreground: RGB | null;
  /** The background varies enough to change the ratio (photo, gradient, text crossing two areas). */
  mixed: boolean;
  unknown?: ContrastUnknown;
}

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

/** A pixel this close to the text color (sum of channel differences) counts as a glyph. Tight on
 *  purpose: a looser match would also drop a background close to the text color, which is exactly
 *  the low-contrast case we are looking for. */
const INK_TOLERANCE = 24;
/** Neighbors within this distance of each other count as a smooth (non-edge) area. */
const SMOOTH_TOLERANCE = 30;
/** A background color must cover this share of the background to count. */
const MIN_SHARE = 0.15;
/** Background counts as mixed when part of it beats the worst ratio by this factor. */
const MIXED_SPREAD = 1.1;
/** Samples per box; larger boxes are read on a stride. 2000 still puts the 15% cut at ~300
 *  pixels, and keeps a 1080p frame with 150 text layers around 20 ms. */
const MAX_SAMPLES = 2000;
/** Below this many background samples (or this share of the box) the result is unknown. */
const MIN_BACKGROUND = 12;
const MIN_BACKGROUND_SHARE = 0.05;

const NEIGHBORS = [1, 0, -1, 0, 0, 1, 0, -1];

/** Tone histogram: steps of 10% in (L + 0.05), so each step is a 10% change in contrast. */
const TONE_STEP = Math.log(1.1);
const TONE_OFFSET = 32; // log(0.05) / TONE_STEP ≈ -31.4
const TONE_BINS = 34;
/** Contrast histogram: steps of 2% over 1–21. */
const CONTRAST_STEP = Math.log(1.02);
const CONTRAST_BINS = 155;

// WCAG 2.x writes the sRGB knee as 0.03928; the sRGB spec says 0.04045. No 8-bit value falls
// between the two, so the results are identical.
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

const byte = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
const lum3 = (r: number, g: number, b: number) => 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];
const ratioOf = (la: number, lb: number) => (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);

/** WCAG relative luminance, 0–1. */
export function luminance(c: RGB): number {
  return lum3(byte(c[0]), byte(c[1]), byte(c[2]));
}

/** WCAG contrast ratio, 1–21. Order does not matter. */
export function contrastRatio(a: RGB, b: RGB): number {
  return ratioOf(luminance(a), luminance(b));
}

/** WCAG large text: 18pt, or 14pt bold. At 96 dpi that is 24px and 18.67px; 18.66 so a size typed
 *  as 18.66 still counts. */
export function isLargeText(fontSize: number, fontWeight: number): boolean {
  return fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
}

/** `fg` at `alpha` over `bg`, as the renderer composites it (in sRGB, like Figma). */
export function blend(fg: RGB, bg: RGB, alpha: number): RGB {
  return [0, 1, 2].map((i) => byte(fg[i] * alpha + bg[i] * (1 - alpha))) as RGB;
}

/** "4.5:1". Truncated, not rounded, so a failing 4.49 never reads as a passing "4.5:1". */
export function formatRatio(ratio: number, digits = 1): string {
  const f = 10 ** digits;
  return `${Math.floor(ratio * f + 1e-9) / f}:1`;
}

/**
 * Contrast for each text layer on one rendered frame.
 * @param pixels RGBA, row-major, top row first (what canvas getImageData returns).
 * @param scale  render pixels per frame pixel (the export's constraint, e.g. 2).
 */
export function checkContrast(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  scale: number,
  texts: ContrastInput[],
): ContrastResult[] {
  if (pixels.length < width * height * 4) throw new Error(`contrast: ${pixels.length} bytes is too few for ${width}×${height}`);
  if (!(scale > 0)) throw new Error(`contrast: bad scale ${scale}`);
  // One concrete array type keeps the hot loop monomorphic (a union of the two is ~2x slower).
  const img: Image = { px: new Uint8Array(pixels.buffer, pixels.byteOffset, width * height * 4), w: width, h: height };
  return texts.map((t) => checkOne(img, scale, t));
}

interface Image { px: Uint8Array; w: number; h: number }
interface Rect { x0: number; y0: number; x1: number; y1: number }
/** Contrast of the text against one background color; `lb` is that color's luminance if known. */
type ContrastOf = (r: number, g: number, b: number, lb?: number) => number;

function checkOne(img: Image, scale: number, t: ContrastInput): ContrastResult {
  const large = isLargeText(t.fontSize, t.fontWeight);
  const required = large ? AA_LARGE : AA_NORMAL;
  const base: ContrastResult = { id: t.id, ratio: null, required, large, pass: null, background: null, foreground: null, mixed: false };
  const { x, y, w, h } = t.box;
  if (!(w > 0 && h > 0)) return { ...base, unknown: 'empty' };
  const alpha = Math.min(1, Math.max(0, t.alpha ?? 1));
  if (alpha === 0) return { ...base, unknown: 'invisible' };

  // Round, not floor/ceil: rounding outward would pick up a row of whatever sits next to the box.
  const clampTo = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v)));
  const rect: Rect = { x0: clampTo(x * scale, img.w), y0: clampTo(y * scale, img.h), x1: clampTo((x + w) * scale, img.w), y1: clampTo((y + h) * scale, img.h) };
  if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return { ...base, unknown: 'off-render' };

  const fg = t.color.map(byte) as RGB;
  const lf = luminance(fg);
  const shown = (bg: RGB): RGB => (alpha < 1 ? blend(fg, bg, alpha) : fg);
  const contrastOf: ContrastOf = alpha < 1
    ? (r, g, b, lb = lum3(r, g, b)) =>
        ratioOf(lum3(byte(fg[0] * alpha + r * (1 - alpha)), byte(fg[1] * alpha + g * (1 - alpha)), byte(fg[2] * alpha + b * (1 - alpha))), lb)
    : (r, g, b, lb = lum3(r, g, b)) => ratioOf(lf, lb);

  // Glyph strokes are at most ~0.1em thick, so an ink-colored pixel with ink 0.15em away in every
  // diagonal direction is not a stroke but an area of the text's own color (white text running onto white).
  const probe = Math.max(2, Math.ceil(t.fontSize * scale * 0.15));
  let s = sample(img, rect, [fg], probe, contrastOf);
  if (s && alpha < 1) {
    // Partly transparent glyphs show as the text color mixed into what is behind them, so the
    // colors to skip are only known once the background is.
    s = sample(img, rect, [fg, ...dominantTones(s).map((bg) => blend(fg, bg, alpha))], probe, contrastOf);
  }
  if (!s) return { ...base, unknown: 'covered' };

  const { background, mixed } = pickBackground(s, contrastOf);
  const foreground = shown(background);
  const ratio = contrastRatio(foreground, background);
  return { ...base, ratio, pass: ratio >= required, background, foreground, mixed };
}

/** Counts plus RGB sums per bin, so each bin can report its mean color. */
class Hist {
  readonly bins: number;
  readonly d: Float64Array;
  total = 0;
  constructor(bins: number) { this.bins = bins; this.d = new Float64Array(bins * 4); }
  /** `k` must be in range; the keys below are by construction. */
  add(k: number, r: number, g: number, b: number) {
    const d = this.d, i = k * 4;
    d[i]++; d[i + 1] += r; d[i + 2] += g; d[i + 3] += b;
    this.total++;
  }
  plus(o: Hist): Hist {
    const h = new Hist(this.bins);
    for (let i = 0; i < h.d.length; i++) h.d[i] = this.d[i] + o.d[i];
    h.total = this.total + o.total;
    return h;
  }
  n(k: number) { return k < 0 || k >= this.bins ? 0 : this.d[k * 4]; }
  mean(k: number): RGB { const i = k * 4, n = this.d[i]; return [byte(this.d[i + 1] / n), byte(this.d[i + 2] / n), byte(this.d[i + 3] / n)]; }
}

interface Samples {
  kept: number;
  /** By background tone: finds the colors that cover much of the box. */
  tone: Hist;
  /** By contrast with the text, smooth pixels only: finds the worst area of a gradient. */
  smooth: Hist;
  /** By contrast with the text, every background pixel: the fallback for busy photos. */
  all: Hist;
}

/** Reads the box on a stride and sorts its background pixels into histograms; null when too
 *  little background is left. */
function sample(img: Image, rect: Rect, inks: RGB[], probe: number, contrastOf: ContrastOf): Samples | null {
  const { px, w: W, h: H } = img;
  const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
  const stride = Math.max(1, Math.ceil(Math.sqrt(area / MAX_SAMPLES)));
  const half = stride >> 1;

  // Colors travel packed as 0xRRGGBB: cheaper than arrays in a loop that runs ~10 reads per sample.
  // Transparent parts of a frame show the page behind them, which is white in a PDF viewer.
  const read = (x: number, y: number) => {
    const i = (y * W + x) * 4, a = px[i + 3];
    if (a === 255) return (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    const k = a / 255, white = 255 * (1 - k);
    return (Math.round(px[i] * k + white) << 16) | (Math.round(px[i + 1] * k + white) << 8) | Math.round(px[i + 2] * k + white);
  };
  const diff = (p: number, q: number) =>
    Math.abs((p >> 16) - (q >> 16)) + Math.abs(((p >> 8) & 255) - ((q >> 8) & 255)) + Math.abs((p & 255) - (q & 255));
  const ink = Int32Array.from(inks, (k) => (k[0] << 16) | (k[1] << 8) | k[2]);
  const isInk = (p: number) => {
    for (let j = 0; j < ink.length; j++) if (diff(p, ink[j]) <= INK_TOLERANCE) return true;
    return false;
  };
  // Diagonal probes are enough: whatever a stroke's direction, at least one diagonal crosses it.
  const probes = [probe, probe, -probe, -probe, probe, -probe, -probe, probe];
  const solidInk = (x: number, y: number) => {
    for (let j = 0; j < 8; j += 2) {
      const xx = x + probes[j], yy = y + probes[j + 1];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || !isInk(read(xx, yy))) return false;
    }
    return true;
  };

  const tone = new Hist(TONE_BINS), smooth = new Hist(CONTRAST_BINS), rough = new Hist(CONTRAST_BINS);
  let total = 0;
  for (let y = rect.y0 + half; y < rect.y1; y += stride) {
    for (let x = rect.x0 + half; x < rect.x1; x += stride) {
      total++;
      const p = read(x, y);
      let even = true;
      if (isInk(p)) {
        if (!solidInk(x, y)) continue; // a glyph
      } else {
        // A pixel touching a glyph is its anti-aliased edge: a mix of text and background color
        // that would read as a low-contrast background. Edges and noise are also "rough", which
        // keeps them out of the worst-area search below. Four neighbors are enough and half the cost.
        let edge = false;
        for (let j = 0; j < 8; j += 2) {
          const xx = x + NEIGHBORS[j], yy = y + NEIGHBORS[j + 1];
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = read(xx, yy);
          if (isInk(q)) { edge = true; break; }
          if (diff(p, q) > SMOOTH_TOLERANCE) even = false;
        }
        if (edge) continue;
      }
      const r = p >> 16, g = (p >> 8) & 255, b = p & 255;
      const lb = lum3(r, g, b);
      tone.add(Math.floor(Math.log(lb + 0.05) / TONE_STEP) + TONE_OFFSET, r, g, b);
      (even ? smooth : rough).add(Math.floor(Math.log(contrastOf(r, g, b, lb)) / CONTRAST_STEP), r, g, b);
    }
  }
  const kept = tone.total;
  if (kept < MIN_BACKGROUND || kept < total * MIN_BACKGROUND_SHARE) return null;
  return { kept, tone, smooth, all: smooth.plus(rough) };
}

/** Tones that cover ≥ 15% of the background. A tone is a local peak plus its two neighbors
 *  (±10% contrast), so slight noise or a bin boundary does not split a flat color. Anti-aliasing
 *  that slipped through spreads thinly across many tones and never makes the cut. */
function dominantTones(s: Samples): RGB[] {
  const { tone, kept } = s;
  const out: RGB[] = [];
  for (let k = 0; k < tone.bins; k++) {
    const n = tone.n(k), lo = tone.n(k - 1), hi = tone.n(k + 1);
    if (n > 0 && n >= lo && n >= hi && (lo + n + hi) / kept >= MIN_SHARE) out.push(tone.mean(k));
  }
  return out;
}

/** Mean color of the lowest-contrast 15% of the background, from a contrast histogram; null when
 *  the histogram does not hold that many samples. */
function worstSlice(hist: Hist, need: number): RGB | null {
  if (hist.total < need) return null;
  let n = 0, r = 0, g = 0, b = 0;
  for (let k = 0; k < hist.bins && n < need; k++) {
    const i = k * 4;
    n += hist.d[i]; r += hist.d[i + 1]; g += hist.d[i + 2]; b += hist.d[i + 3];
  }
  return [byte(r / n), byte(g / n), byte(b / n)];
}

/** The worst of the dominant tones and the worst smooth area (a gradient's far end has no single
 *  dominant tone). With neither, the box is busy everywhere, like a photo: use its worst 15%.
 *
 *  Mixed means ≥ 15% of the background has clearly better contrast than the worst. Only better
 *  counts: leftover anti-aliasing is always worse than the true background, so it cannot make
 *  plain text on a flat color look mixed. */
function pickBackground(s: Samples, contrastOf: ContrastOf): { background: RGB; mixed: boolean } {
  const need = s.kept * MIN_SHARE;
  const candidates = dominantTones(s);
  const slice = worstSlice(s.smooth, need);
  if (slice) candidates.push(slice);
  if (!candidates.length) return { background: worstSlice(s.all, need)!, mixed: true };
  let background = candidates[0], worst = Infinity;
  for (const rgb of candidates) { const r = contrastOf(...rgb); if (r < worst) { worst = r; background = rgb; } }
  let better = 0;
  for (let k = Math.floor(Math.log(worst * MIXED_SPREAD) / CONTRAST_STEP) + 1; k < s.all.bins; k++) better += s.all.n(k);
  return { background, mixed: better >= need };
}
