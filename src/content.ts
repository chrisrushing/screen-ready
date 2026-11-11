/**
 * A minimal PDF content-stream scanner: just enough to know where each image is painted.
 *
 * It tracks the transformation matrix through q, Q and cm. At each `Do`, that matrix maps the
 * image's unit square onto the page, which gives the image's placed bounds in page space (PDF
 * points, origin bottom-left — the same space as a Figma node's bbox in this plugin).
 * Strings, hex strings, dictionaries and inline images are skipped so their bytes can't be
 * mistaken for operators.
 */
import { endOfInlineImage } from './slim.ts';

export interface Placement {
  /** XObject resource name, with slash: "/X1". */
  name: string;
  /** Which `Do` of this name this is, in stream order (0-based). */
  occurrence: number;
  /** Placed width and height, in points. */
  w: number;
  h: number;
  /** Placed bounds [x0, y0, x1, y1] in page space. */
  bounds: [number, number, number, number];
  /** The full matrix at the `Do`, for following a form XObject into its own content. */
  ctm: number[];
}

/** start: the matrix in effect when this content begins (a form's Matrix × where it was drawn). */
export function scanPlacements(content: string, start: number[] = [1, 0, 0, 1, 0, 0]): Placement[] {
  const out: Placement[] = [];
  const seen = new Map<string, number>();
  let ctm = start;
  const stack: number[][] = [];
  let ops: string[] = [];
  let i = 0;
  const L = content.length;
  const isWs = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const isDelim = (c: string) => '()<>[]{}/%'.includes(c);
  while (i < L) {
    const c = content[i];
    if (isWs(c)) { i++; continue; }
    if (c === '%') { while (i < L && content[i] !== '\n' && content[i] !== '\r') i++; continue; }
    if (c === '(') {
      let depth = 0;
      for (; i < L; i++) {
        const d = content[i];
        if (d === '\\') { i++; continue; }
        if (d === '(') depth++;
        else if (d === ')' && --depth === 0) { i++; break; }
      }
      ops.push('(str)');
      continue;
    }
    if (c === '<') {
      if (content[i + 1] === '<') { i += 2; continue; }
      const end = content.indexOf('>', i);
      i = end < 0 ? L : end + 1;
      ops.push('<hex>');
      continue;
    }
    if (c === '>' || c === '[' || c === ']' || c === '{' || c === '}') { i++; continue; }
    let j = i + 1;
    while (j < L && !isWs(content[j]) && !isDelim(content[j])) j++;
    const tok = content.slice(i, j);
    i = j;
    if (tok.startsWith('/') || /^[-+.\d]/.test(tok)) { ops.push(tok); continue; }
    switch (tok) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]; break;
      case 'cm': {
        const [a, b, c2, d, e, f] = ops.slice(-6).map(Number);
        const [A, B, C, D, E, F] = ctm;
        ctm = [a * A + b * C, a * B + b * D, c2 * A + d * C, c2 * B + d * D, e * A + f * C + E, e * B + f * D + F];
        break;
      }
      case 'Do': {
        const name = ops[ops.length - 1];
        const occurrence = seen.get(name) ?? 0;
        seen.set(name, occurrence + 1);
        const [a, b, c2, d, e, f] = ctm;
        const xs = [e, a + e, c2 + e, a + c2 + e];
        const ys = [f, b + f, d + f, b + d + f];
        out.push({
          name, occurrence,
          w: Math.hypot(a, b), h: Math.hypot(c2, d),
          bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          ctm,
        });
        break;
      }
      case 'BI': {
        const ei = endOfInlineImage(content, i);
        i = ei < 0 ? L : ei;
        break;
      }
    }
    ops = [];
  }
  return out;
}

/** Area of the intersection of two [x0, y0, x1, y1] boxes. */
export function overlap(a: [number, number, number, number], b: [number, number, number, number]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** One painting operation: a filled/stroked path, an image, or a clip — with where it lands. */
export interface Paint {
  kind: 'path' | 'image' | 'clip';
  /** Byte offsets in the (latin1) content string: from the first operand of the path's
   *  construction, or the q that encloses it, to just after the painting operator. */
  start: number;
  end: number;
  bounds: [number, number, number, number];
  /** Marked-content depth when painted (inside Figma's artifact this is 1). */
  mcDepth: number;
}

/**
 * Every painting operation in a content stream, with page-space bounds. Path construction
 * (m l c v y re h) is collected under the current matrix and closed by a paint (f F f* S s B B* b
 * b* n). Used to find the paths that draw a vector logo, so they can be tagged as a Figure.
 */
export function scanPaints(content: string, start: number[] = [1, 0, 0, 1, 0, 0]): Paint[] {
  const out: Paint[] = [];
  let ctm = start;
  const stack: Array<{ ctm: number[]; at: number }> = [];
  let ops: string[] = [];
  let opsStart = -1;
  let pathStart = -1;
  let pts: number[][] = [];
  let mcDepth = 0;
  let clipping = false;
  let i = 0;
  const L = content.length;
  const isWs = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const isDelim = (c: string) => '()<>[]{}/%'.includes(c);
  const tx = (x: number, y: number) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const box = (p: number[][]): [number, number, number, number] => {
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const operand = (at: number) => { if (opsStart < 0) opsStart = at; };
  while (i < L) {
    const c = content[i];
    if (isWs(c)) { i++; continue; }
    if (c === '%') { while (i < L && content[i] !== '\n' && content[i] !== '\r') i++; continue; }
    if (c === '(') {
      operand(i);
      let depth = 0;
      for (; i < L; i++) {
        const d = content[i];
        if (d === '\\') { i++; continue; }
        if (d === '(') depth++;
        else if (d === ')' && --depth === 0) { i++; break; }
      }
      ops.push('(str)');
      continue;
    }
    if (c === '<') {
      operand(i);
      if (content[i + 1] === '<') { i += 2; continue; }
      const e = content.indexOf('>', i);
      i = e < 0 ? L : e + 1;
      ops.push('<hex>');
      continue;
    }
    if (c === '>' || c === '[' || c === ']' || c === '{' || c === '}') { if (c === '[') operand(i); i++; continue; }
    const at = i;
    let j = i + 1;
    while (j < L && !isWs(content[j]) && !isDelim(content[j])) j++;
    const tok = content.slice(i, j);
    i = j;
    if (tok.startsWith('/') || /^[-+.\d]/.test(tok)) { operand(at); ops.push(tok); continue; }
    const num = (k: number) => Number(ops[ops.length - k]);
    const begin = opsStart >= 0 ? opsStart : at;
    switch (tok) {
      case 'q': stack.push({ ctm, at }); break;
      case 'Q': ctm = stack.pop()?.ctm ?? [1, 0, 0, 1, 0, 0]; break;
      case 'cm': {
        const [a, b, c2, d, e, f] = ops.slice(-6).map(Number);
        const [A, B, C, D, E, F] = ctm;
        ctm = [a * A + b * C, a * B + b * D, c2 * A + d * C, c2 * B + d * D, e * A + f * C + E, e * B + f * D + F];
        break;
      }
      case 'BMC': case 'BDC': mcDepth++; break;
      case 'EMC': mcDepth--; break;
      case 'm': case 'l':
        if (pathStart < 0) pathStart = begin;
        pts.push(tx(num(2), num(1)));
        break;
      case 'c': case 'v': case 'y':
        if (pathStart < 0) pathStart = begin;
        for (let k = ops.length; k >= 2; k -= 2) pts.push(tx(num(k), num(k - 1)));
        break;
      case 're': {
        if (pathStart < 0) pathStart = begin;
        const [x, y, w, h] = [num(4), num(3), num(2), num(1)];
        pts.push(tx(x, y), tx(x + w, y), tx(x, y + h), tx(x + w, y + h));
        break;
      }
      case 'W': case 'W*': clipping = true; break;
      case 'f': case 'F': case 'f*': case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': case 'n':
        if (pts.length && pathStart >= 0) {
          out.push({ kind: tok === 'n' && clipping ? 'clip' : tok === 'n' ? 'clip' : 'path', start: pathStart, end: i, bounds: box(pts), mcDepth });
        }
        pts = []; pathStart = -1; clipping = false;
        break;
      case 'Do': {
        const [a, b, c2, d, e, f] = ctm;
        out.push({ kind: 'image', start: begin, end: i, bounds: box([[e, f], [a + e, b + f], [c2 + e, d + f], [a + c2 + e, b + d + f]]), mcDepth });
        break;
      }
      case 'BI': {
        const ei = endOfInlineImage(content, i);
        i = ei < 0 ? L : ei;
        break;
      }
    }
    ops = [];
    opsStart = -1;
  }
  return out;
}
