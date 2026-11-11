/**
 * Text split across layers that's one thing when read.
 *
 *   - A heading broken into one layer per line ("Every page" / "reads in order"): read as
 *     two headings, and listed twice in the outline.
 *   - A drop cap: a big "T" as its own layer, then "he report shows…": read "T", "he report…".
 *   - A number built from pieces: "$" + "120" + "K", or "40" + "%": read as three bits.
 *
 * Each is read as one element: the first piece carries the rest. Pieces a person set to a
 * different role by hand, and layers inside a table, list or chart, are left as they are.
 */
import type { ItemState } from './messages.ts';
import type { TextRole } from './types.ts';

export interface Join {
  /** The piece read first; the element is built from it. */
  head: string;
  /** The rest, in reading order, each with what goes between it and the piece before. */
  pieces: Array<{ id: string; sep: string }>;
  kind: 'heading' | 'drop cap' | 'number';
  /** The piece whose role the whole reads as: the heading, the paragraph after a drop cap, the digits of a number. */
  lead: string;
}

const norm = (s = '') => s.replace(/\s+/g, ' ').trim();
const size = (i: ItemState) => i.fontSize ?? 16;
/** PDF points, origin bottom-left: top edge is bbox[3]. */
const top = (i: ItemState) => i.bbox[3];
const bottom = (i: ItemState) => i.bbox[1];
const sameStyle = (a: ItemState, b: ItemState) =>
  Math.abs(size(a) - size(b)) <= 0.5 && (a.fontWeight ?? 400) === (b.fontWeight ?? 400) && (a.fontFamily ?? '') === (b.fontFamily ?? '') && !!a.italic === !!b.italic;
const aligned = (a: ItemState, b: ItemState) =>
  Math.abs(a.bbox[0] - b.bbox[0]) <= 4 || Math.abs(a.bbox[2] - b.bbox[2]) <= 4 ||
  Math.abs((a.bbox[0] + a.bbox[2]) / 2 - (b.bbox[0] + b.bbox[2]) / 2) <= 4;
const isHeading = (r?: TextRole) => !!r && /^H[1-6]$/.test(r);
const NUMBER = /^[+\-−–]?[$€£¥]?\d[\d,.]*\s?(%|[kmb]|bn|mn|pp|x|\+)?$/i;

export function findJoins(items: ItemState[], roleOf: (i: ItemState) => TextRole | undefined, skip: Set<string> = new Set()): Join[] {
  // A lone "$" or "%" is skipped as a symbol on its own, but beside digits it's part of the number.
  const symbol = (i: ItemState) => /^[$€£¥%+]$/.test(norm(i.text));
  const texts = items.filter((i) => i.kind === 'text' && !skip.has(i.nodeId) && !i.inChart && (roleOf(i) !== 'Artifact' || symbol(i)) && norm(i.text));
  const out: Join[] = [];
  const used = new Set<string>();

  // Headings, one layer per line: same style, lined up, the next line right under the last.
  for (let k = 0; k < texts.length; k++) {
    const a = texts[k];
    if (used.has(a.nodeId) || !isHeading(roleOf(a))) continue;
    const join: Join = { head: a.nodeId, pieces: [], kind: 'heading', lead: a.nodeId };
    let last = a;
    for (let j = k + 1; j < texts.length; j++) {
      const b = texts[j];
      const gap = bottom(last) - top(b);
      const lines = (top(b) - bottom(b)) / (size(b) * 1.1);
      const ok = !used.has(b.nodeId) && sameStyle(a, b) && aligned(last, b) && gap >= -0.3 * size(b) && gap <= 0.6 * size(b) &&
        lines <= 3.2 && !/[.!?]$/.test(norm(last.text)) && (!b.roleSet || roleOf(b) === roleOf(a));
      if (!ok) break;
      join.pieces.push({ id: b.nodeId, sep: ' ' });
      last = b;
    }
    if (join.pieces.length) { out.push(join); for (const id of [join.head, ...join.pieces.map((p) => p.id)]) used.add(id); }
  }

  // Drop caps: one or two big letters, the paragraph starting lowercase right beside them.
  for (const cap of texts) {
    if (used.has(cap.nodeId) || !/^\p{L}{1,2}$/u.test(norm(cap.text))) continue;
    const body = texts.find((b) => b !== cap && !used.has(b.nodeId) && /^\p{Ll}/u.test(norm(b.text)) && size(cap) >= 1.8 * size(b) &&
      cap.bbox[0] <= b.bbox[0] && b.bbox[0] - cap.bbox[2] <= 16 && Math.abs(top(cap) - top(b)) <= 0.6 * size(cap) && (!b.roleSet || b.role === 'P'));
    if (!body) continue;
    out.push({ head: cap.nodeId, pieces: [{ id: body.nodeId, sep: '' }], kind: 'drop cap', lead: body.nodeId });
    used.add(cap.nodeId); used.add(body.nodeId);
  }

  // Numbers in pieces: short bits side by side on one line that read as one figure together.
  const short = texts.filter((i) => !used.has(i.nodeId) && norm(i.text).length <= 6 && !/\s/.test(norm(i.text)))
    .sort((a, b) => a.bbox[0] - b.bbox[0]);
  for (const a of short) {
    if (used.has(a.nodeId)) continue;
    const chain = [a];
    for (;;) {
      const last = chain[chain.length - 1];
      const maxSize = Math.max(...chain.map(size));
      const next = short.find((b) => !used.has(b.nodeId) && !chain.includes(b) && b.bbox[0] - last.bbox[2] >= -0.15 * Math.max(maxSize, size(b)) &&
        b.bbox[0] - last.bbox[2] <= 0.35 * Math.max(maxSize, size(b)) && bottom(b) < top(last) && bottom(last) < top(b));
      if (!next) break;
      chain.push(next);
    }
    const whole = chain.map((c) => norm(c.text)).join('');
    if (chain.length < 2 || !/\d/.test(whole) || !NUMBER.test(whole)) continue;
    out.push({ head: chain[0].nodeId, pieces: chain.slice(1).map((c) => ({ id: c.nodeId, sep: '' })), kind: 'number', lead: chain.find((c) => /\d/.test(c.text ?? ''))!.nodeId });
    for (const c of chain) used.add(c.nodeId);
  }
  return out;
}

/** "S P E C T E R  O P S" → "SPECTER OPS": letters typed apart, read as the word they spell. */
export function spacedLetters(text: string): string | null {
  const t = text.trim();
  if (!/^(\p{L}|\p{N})( (\p{L}|\p{N})){3,}(( {2,}|\s*[·|]\s*)(\p{L}|\p{N})( (\p{L}|\p{N}))*)*$/u.test(t)) return null;
  return t.split(/ {2,}|\s*[·|]\s*/).map((w) => w.replace(/ /g, '')).join(' ');
}

/** Text left in from a template: "Lorem ipsum", "Headline goes here", "Your text here". */
export const PLACEHOLDER_TEXT = /\b(lorem ipsum|dolor sit amet|consectetur adipiscing)\b|\bgoes here\b|\byour (text|title|headline|copy|name|caption) here\b|\binsert (text|title|copy|headline)\b|\bplaceholder text\b/i;

/** The later copy of each paragraph (8+ words) that appears twice on one page: read twice. */
export function repeatedParagraphs(items: ItemState[], skipped: (i: ItemState) => boolean): ItemState[] {
  const seen = new Set<string>();
  const out: ItemState[] = [];
  for (const i of items) {
    if (i.kind !== 'text' || skipped(i)) continue;
    const t = norm(i.text);
    if (t.split(' ').length < 8) continue;
    if (seen.has(t)) out.push(i); else seen.add(t);
  }
  return out;
}

