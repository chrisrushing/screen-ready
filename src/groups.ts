/**
 * Removes transparency groups that wrap a single drawing, so Apple's PDF renderer blends them right.
 *
 * Figma puts each layer with a blend mode or opacity in its own form XObject, marked as an isolated
 * transparency group, and applies the blend mode (Overlay, Multiply…) where the form is drawn.
 * That is correct PDF, and Acrobat and Chrome draw it the way the canvas does. Apple's renderer
 * (Preview, Quick Look, Safari, every Mac and iPhone app built on PDFKit) does not: it draws such a
 * group as if its blend mode were Normal. A grain texture set to Overlay at 30% turns a dark page
 * into a flat gray haze.
 *
 * When a group holds exactly one drawing (one fill, one stroke, one image, one shading, one run of
 * text), the group changes nothing: one object composited on its own and then blended is the same
 * as that object blended directly. So the form's /Group entry is dropped, and the drawing takes the
 * blend mode and opacity from where the form is drawn, which every renderer handles. Groups with
 * more than one drawing, their own graphics state changes (gs), nested forms, or a blending color
 * space are left exactly as they are, since there the group does change the result.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { endOfInlineImage } from './slim.ts';

/** Painting operators: each draws one object. */
const PAINT = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's', 'sh', 'Do', 'Tj', 'TJ', "'", '"']);

/**
 * The drawings in a content stream, or null when it does something that makes a group matter:
 * a graphics state change (gs), or anything this reader doesn't follow.
 */
export function drawings(src: string): Array<{ op: string; name?: string }> | null {
  const out: Array<{ op: string; name?: string }> = [];
  const isWs = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const isDelim = (c: string) => '()<>[]{}/%'.includes(c);
  let lastName: string | undefined;
  let i = 0;
  const L = src.length;
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
        let depth = 0;
        for (; i < L; i++) {
          if (src[i] === '<' && src[i + 1] === '<') { depth++; i++; }
          else if (src[i] === '>' && src[i + 1] === '>') { depth--; i++; if (depth === 0) { i++; break; } }
        }
        continue;
      }
      const end = src.indexOf('>', i);
      i = end < 0 ? L : end + 1;
      continue;
    }
    if ('[]>{}'.includes(c)) { i++; continue; }
    let j = i + 1;
    while (j < L && !isWs(src[j]) && !isDelim(src[j])) j++;
    const tok = src.slice(i, j);
    i = j;
    if (tok.startsWith('/')) { lastName = tok; continue; }
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) continue;
    if (tok === 'gs') return null;
    if (tok === 'BI') {
      const ei = endOfInlineImage(src, j);
      if (ei < 0) return null;
      out.push({ op: 'BI' });
      i = ei;
      continue;
    }
    if (PAINT.has(tok)) out.push({ op: tok, name: tok === 'Do' ? lastName : undefined });
  }
  return out;
}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
  return s;
};

/** Drops /Group from form XObjects that draw a single object. Returns how many it changed. */
export function dropSingleDrawingGroups(doc: PDFDocument): number {
  const n = (s: string) => PDFName.of(s);
  let changed = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || String(obj.dict.get(n('Subtype'))) !== '/Form') continue;
    const group = obj.dict.lookupMaybe(n('Group'), PDFDict);
    if (!group || String(group.get(n('S'))) !== '/Transparency' || group.has(n('CS'))) continue;
    // A form with a soft mask of its own, or used as one, is about masking, not blending: leave it.
    if (obj.dict.has(n('SMask'))) continue;
    const filters = obj.dict.get(n('Filter'));
    const names = filters instanceof PDFArray ? filters.asArray().map(String) : filters ? [String(filters)] : [];
    if (names.some((f) => f !== '/FlateDecode') || obj.dict.has(n('DecodeParms'))) continue;
    let text: string;
    try { text = latin1(decodePDFRawStream(obj).decode()); } catch { continue; }
    const drawn = drawings(text);
    if (!drawn || drawn.length !== 1) continue;
    // One image is one drawing; one form could be many.
    if (drawn[0].op === 'Do') {
      const xobjects = obj.dict.lookupMaybe(n('Resources'), PDFDict)?.lookupMaybe(n('XObject'), PDFDict);
      const target = drawn[0].name && xobjects?.lookup(n(drawn[0].name.slice(1)));
      if (!(target instanceof PDFRawStream) || String(target.dict.get(n('Subtype'))) !== '/Image') continue;
    }
    obj.dict.delete(n('Group'));
    changed++;
  }
  return changed;
}
