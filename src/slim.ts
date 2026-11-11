/**
 * Lossless-looking size reduction for vector content.
 *
 * Figma writes every number in its drawing code with six decimals — "1.000000 0.000000 -0.000000
 * 1.000000 0.000000 0.000000 cm", every path point to a millionth of a point. Text is drawn as
 * outlines, so a page of type is hundreds of thousands of such numbers. Rounding each one to the
 * precision its operator needs (a hundredth of a point for path coordinates, which is about a
 * 0.0035 mm — far below what any screen or printer shows) and recompressing at the highest level
 * roughly halves the vector part of a file, with no visible change.
 *
 * Only numbers that are operands of drawing operators are touched. Strings, hex strings, inline
 * images, and the dictionaries of marked content (where the accessibility tags' MCIDs live) are
 * copied exactly.
 */
import pako from 'pako';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';

/** Decimals kept for each operator's numbers. */
const DECIMALS: Record<string, number> = {
  // Path construction: page coordinates in points.
  m: 2, l: 2, c: 2, v: 2, y: 2, re: 2,
  // Text positioning and spacing.
  Td: 3, TD: 3, Tc: 3, Tw: 3, TL: 3, Ts: 3, Tz: 3, Tf: 3, TJ: 2, "'": 3, '"': 3,
  // Colors: 0–1 per channel; 3 decimals is finer than 8-bit color.
  rg: 4, RG: 4, g: 4, G: 4, k: 4, K: 4, sc: 4, SC: 4, scn: 4, SCN: 4,
  // Line width, dash pattern, miter limit, flatness.
  w: 3, d: 3, M: 3, i: 3,
  // Matrices: scale and skew need more precision than translation (see fmtMatrix).
  cm: 5, Tm: 5,
};

/** Shortest form of a number rounded to `dec` decimals: "1.000000" → "1", "-0.000000" → "0". */
function fmt(v: number, dec: number, relative = false): string {
  // A matrix's scale and skew multiply everything after them, so they keep relative precision
  // (6 significant digits) — a 0.000041 scale stays 0.000041, not 0.00004 (a 2% size error).
  let r = relative && v !== 0 && Math.abs(v) < 1 ? Number(v.toPrecision(6)) : Number(v.toFixed(dec));
  if (Object.is(r, -0)) r = 0;
  const s = String(r);
  // Exponent notation isn't valid PDF syntax.
  return s.includes('e') ? r.toFixed(10).replace(/\.?0+$/, '') : s;
}

/** Just past the EI that ends an inline image, or -1: EI on its own, not two bytes of image data. */
export function endOfInlineImage(src: string, from: number): number {
  const re = /\sEI(?=[\s]|$)/g;
  re.lastIndex = from;
  const m = re.exec(src);
  return m ? m.index + 3 : -1;
}

/** Rounds the numeric operands in one content stream. Returns the input unchanged if anything looks off. */
export function slimContent(src: string): string {
  const out: string[] = [];
  let last = 0; // copied up to here
  let i = 0;
  const L = src.length;
  let pending: Array<{ start: number; end: number; value: number; real: boolean }> = [];
  let arrayDepth = 0;
  const isWs = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const isDelim = (c: string) => '()<>[]{}/%'.includes(c);

  const flush = (op: string) => {
    const dec = DECIMALS[op];
    if (dec !== undefined) {
      const isMatrix = op === 'cm' || op === 'Tm';
      pending.forEach((p, k) => {
        // Matrix translation (the last two numbers) is a position: points, 2 decimals is plenty.
        const translation = isMatrix && k >= pending.length - 2;
        // Only reals are worth rewriting; integers are already short. (They still count above.)
        if (!p.real) return;
        out.push(src.slice(last, p.start), fmt(p.value, translation ? 3 : dec, isMatrix && !translation));
        last = p.end;
      });
    }
    pending = [];
  };

  while (i < L) {
    const c = src[i];
    if (isWs(c)) { i++; continue; }
    if (c === '%') { while (i < L && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '(') {
      let depth = 0;
      for (; i < L; i++) {
        const d = src[i];
        if (d === '\\') { i++; continue; }
        if (d === '(') depth++;
        else if (d === ')' && --depth === 0) { i++; break; }
      }
      continue;
    }
    if (c === '<') {
      if (src[i + 1] === '<') {
        // A dictionary (marked-content properties): skip it whole, numbers and all.
        let depth = 0;
        for (; i < L; i++) {
          if (src[i] === '<' && src[i + 1] === '<') { depth++; i++; }
          else if (src[i] === '>' && src[i + 1] === '>') { depth--; i++; if (depth === 0) { i++; break; } }
          else if (src[i] === '(') { // a string inside the dictionary
            let sd = 0;
            for (; i < L; i++) { const d = src[i]; if (d === '\\') { i++; continue; } if (d === '(') sd++; else if (d === ')' && --sd === 0) break; }
          }
        }
        pending = [];
        continue;
      }
      const end = src.indexOf('>', i);
      i = end < 0 ? L : end + 1;
      continue;
    }
    if (c === '[') { arrayDepth++; i++; continue; }
    if (c === ']') { arrayDepth = Math.max(0, arrayDepth - 1); i++; continue; }
    if (c === '>' || c === '{' || c === '}') { i++; continue; }
    let j = i + 1;
    while (j < L && !isWs(src[j]) && !isDelim(src[j])) j++;
    const tok = src.slice(i, j);
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      pending.push({ start: i, end: j, value: Number(tok), real: tok.includes('.') });
    } else if (tok.startsWith('/')) {
      // A name operand (a color space, font, pattern): keep collecting.
    } else if (tok === 'BI') {
      // Inline image: copy through EI untouched.
      const ei = endOfInlineImage(src, j);
      if (ei < 0) return src;
      pending = [];
      i = ei;
      continue;
    } else if (arrayDepth === 0) {
      flush(tok);
    }
    i = j;
  }
  out.push(src.slice(last));
  return out.join('');
}

const latin1 = {
  decode(b: Uint8Array): string {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
    return s;
  },
  encode(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  },
};

/**
 * Slims every page content stream and form XObject in the document, in place (same objects, new
 * data). Returns bytes before and after, compressed.
 */
export function slimVectors(doc: PDFDocument): { before: number; after: number } {
  const n = (s: string) => PDFName.of(s);
  const targets = new Set<string>();
  const refs: PDFRef[] = [];
  const add = (r: unknown) => { if (r instanceof PDFRef && !targets.has(r.toString())) { targets.add(r.toString()); refs.push(r); } };
  for (const page of doc.getPages()) {
    const c = page.node.get(n('Contents'));
    if (c instanceof PDFArray) c.asArray().forEach(add); else add(c);
  }
  for (const [ref, obj] of doc.context.enumerateIndirectObjects())
    if (obj instanceof PDFRawStream && String(obj.dict.get(n('Subtype'))) === '/Form') add(ref);

  let before = 0, after = 0;
  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const filters = stream.dict.get(n('Filter'));
    const names = filters instanceof PDFArray ? filters.asArray().map(String) : filters ? [String(filters)] : [];
    if (names.some((f) => f !== '/FlateDecode')) continue; // only plain or Flate streams
    if (stream.dict.has(n('DecodeParms'))) continue;
    let text: string;
    try { text = latin1.decode(decodePDFRawStream(stream).decode()); } catch { continue; }
    const packed = pako.deflate(latin1.encode(slimContent(text)), { level: 9 });
    const old = stream.getContents().length;
    before += old;
    if (packed.length >= old) { after += old; continue; }
    const dict = stream.dict.clone(doc.context);
    dict.set(n('Filter'), n('FlateDecode'));
    doc.context.assign(ref, PDFRawStream.of(dict, packed));
    after += packed.length;
  }
  return { before, after };
}
