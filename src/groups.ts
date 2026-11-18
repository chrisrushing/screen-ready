/**
 * Rewrites Figma's transparency groups so Apple's PDF renderer blends layers the way the canvas does.
 *
 * Figma wraps layers in form XObjects marked as transparency groups: every frame that clips its
 * content becomes a group drawn through a soft mask (the frame's shape), and every layer with a
 * blend mode or opacity becomes a group of its own. That is correct PDF, and Acrobat and Chrome
 * draw it right. Apple's renderer (Preview, Quick Look, Safari, Mail, every Mac and iPhone app built
 * on PDFKit) does not: inside a group it blends against the group's own empty backdrop instead of
 * the page beneath. A grain texture set to Overlay at 30% over a dark page comes out as a gray haze.
 *
 * Three rewrites, each of which leaves the picture the same in a correct renderer:
 *
 * 1. A soft mask that is one solid shape (a frame's clip: an opaque fill, alpha mask) becomes a
 *    clipping path. Anti-aliased edges aside, a mask that is 1 inside a shape and 0 outside is that
 *    shape's clip.
 * 2. A group drawn with Normal blending, full opacity and no mask, that is not isolated or knockout,
 *    is no group at all: its contents composited onto the page directly come out the same.
 * 3. A group that holds exactly one drawing (one fill, image, shading or run of text) is the same
 *    as that drawing on its own, so it takes the blend mode and opacity from where it is drawn.
 *
 * Anything else (soft masks that fade, groups with several drawings and their own blend, blending
 * color spaces, knockout groups) is left exactly as it is.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import pako from 'pako';
import { endOfInlineImage } from './slim.ts';

/** Painting operators: each draws one object. */
const PAINT = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's', 'sh', 'Do', 'Tj', 'TJ', "'", '"']);
const PATH = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
const COLOR = new Set(['g', 'rg', 'k', 'cs', 'sc', 'scn', 'G', 'RG', 'K', 'CS', 'SC', 'SCN']);

type Token = { t: string; s: number; e: number };

/** Content-stream tokens (operators, names, numbers) with their positions; strings and dictionaries skipped. */
export function tokens(src: string): Token[] | null {
  const out: Token[] = [];
  const isWs = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const isDelim = (c: string) => '()<>[]{}/%'.includes(c);
  let i = 0;
  const L = src.length;
  while (i < L) {
    const c = src[i];
    if (isWs(c)) { i++; continue; }
    if (c === '%') { while (i < L && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '(') {
      const s = i;
      let depth = 0;
      for (; i < L; i++) {
        const d = src[i];
        if (d === '\\') { i++; continue; }
        if (d === '(') depth++;
        else if (d === ')' && --depth === 0) { i++; break; }
      }
      out.push({ t: '(…)', s, e: i });
      continue;
    }
    if (c === '<') {
      const s = i;
      if (src[i + 1] === '<') {
        let depth = 0;
        for (; i < L; i++) {
          if (src[i] === '<' && src[i + 1] === '<') { depth++; i++; }
          else if (src[i] === '>' && src[i + 1] === '>') { depth--; i++; if (depth === 0) { i++; break; } }
        }
        out.push({ t: '<<…>>', s, e: i });
        continue;
      }
      const end = src.indexOf('>', i);
      i = end < 0 ? L : end + 1;
      out.push({ t: '<…>', s, e: i });
      continue;
    }
    if ('[]{}>'.includes(c)) { out.push({ t: c, s: i, e: i + 1 }); i++; continue; }
    let j = i + 1;
    while (j < L && !isWs(src[j]) && !isDelim(src[j])) j++;
    const t = src.slice(i, j);
    out.push({ t, s: i, e: j });
    i = j;
    if (t === 'BI') {
      const ei = endOfInlineImage(src, j);
      if (ei < 0) return null;
      out.push({ t: 'EI', s: ei - 2, e: ei });
      i = ei;
    }
  }
  return out;
}

const isOperator = (t: string) => /^[A-Za-z'"*]+$/.test(t) && t !== 'true' && t !== 'false' && t !== 'null';

/** The drawings in a content stream, or null when it changes graphics state (gs) or can't be read. */
export function drawings(src: string): Array<{ op: string; name?: string }> | null {
  const toks = tokens(src);
  if (!toks) return null;
  const out: Array<{ op: string; name?: string }> = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k].t;
    if (t === 'gs') return null;
    if (t === 'BI') out.push({ op: 'BI' });
    else if (PAINT.has(t)) out.push({ op: t, name: t === 'Do' ? toks[k - 1]?.t : undefined });
  }
  return out;
}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
  return s;
};
const bytes = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const num = (v: number) => { const r = Number(v.toFixed(4)); return String(Object.is(r, -0) ? 0 : r); };

/**
 * A soft mask's group as a clipping path, when the mask is one opaque fill and nothing else:
 * "x y m … h W n" in the coordinates where the mask is set. Null otherwise.
 */
export function maskAsClip(content: string, matrix: M = [1, 0, 0, 1, 0, 0]): string | null {
  const toks = tokens(content);
  if (!toks) return null;
  let ctm: M = [1, 0, 0, 1, 0, 0];
  let depth = 0;
  let fill: string | null = null;
  const path: string[] = [];
  let operands: number[] = [];
  const pt = (x: number, y: number) => {
    const m = mul(ctm, matrix);
    return `${num(x * m[0] + y * m[2] + m[4])} ${num(x * m[1] + y * m[3] + m[5])}`;
  };
  for (const { t } of toks) {
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) { operands.push(Number(t)); continue; }
    if (t.startsWith('/')) continue; // a color space name
    if (!isOperator(t)) return null;
    const o = operands;
    operands = [];
    if (t === 'q') { depth++; continue; }
    if (t === 'Q') { depth--; continue; }
    if (t === 'cm') { if (o.length !== 6 || path.length) return null; ctm = mul(o as M, ctm); continue; }
    if (COLOR.has(t)) {
      // Alpha masks ignore color; anything fainter than opaque would be a fade.
      continue;
    }
    if (PATH.has(t)) {
      if (fill) return null;
      if (t === 'm' || t === 'l') path.push(`${pt(o[0], o[1])} ${t}`);
      else if (t === 'c') path.push(`${pt(o[0], o[1])} ${pt(o[2], o[3])} ${pt(o[4], o[5])} c`);
      else if (t === 'v' || t === 'y') path.push(`${pt(o[0], o[1])} ${pt(o[2], o[3])} ${t}`);
      else if (t === 're') path.push(`${pt(o[0], o[1])} m ${pt(o[0] + o[2], o[1])} l ${pt(o[0] + o[2], o[1] + o[3])} l ${pt(o[0], o[1] + o[3])} l h`);
      else path.push('h');
      continue;
    }
    if (t === 'f' || t === 'F' || t === 'f*') { if (fill || !path.length) return null; fill = t === 'f*' ? 'W*' : 'W'; continue; }
    if (t === 'n') continue;
    return null; // a stroke, image, gs, text, shading…: not a plain shape
  }
  if (!fill || depth !== 0) return null;
  return `${path.join(' ')} ${fill} n`;
}

type Stream = { ref: PDFRef; obj: PDFRawStream; res: PDFDict | undefined };

/** Page content streams, form XObjects and tiling patterns: everything that can draw a form. */
function contentStreams(doc: PDFDocument): Stream[] {
  const n = (s: string) => PDFName.of(s);
  const out: Stream[] = [];
  for (const page of doc.getPages()) {
    const c = page.node.get(n('Contents'));
    for (const r of c instanceof PDFArray ? c.asArray() : [c]) {
      const obj = r instanceof PDFRef ? doc.context.lookup(r) : undefined;
      if (r instanceof PDFRef && obj instanceof PDFRawStream) out.push({ ref: r, obj, res: page.node.Resources() });
    }
  }
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const isForm = String(obj.dict.get(n('Subtype'))) === '/Form';
    const isPattern = obj.dict.lookupMaybe(n('PatternType'), PDFNumber)?.asNumber() === 1;
    if (isForm || isPattern) out.push({ ref, obj, res: obj.dict.lookupMaybe(n('Resources'), PDFDict) });
  }
  return out;
}

const readable = (obj: PDFRawStream) => {
  const f = obj.dict.get(PDFName.of('Filter'));
  const names = f instanceof PDFArray ? f.asArray().map(String) : f ? [String(f)] : [];
  return names.every((x) => x === '/FlateDecode') && !obj.dict.has(PDFName.of('DecodeParms'));
};

function rewrite(doc: PDFDocument, s: Stream, text: string) {
  const dict = s.obj.dict.clone(doc.context);
  dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  dict.delete(PDFName.of('DecodeParms'));
  s.obj = PDFRawStream.of(dict, pako.deflate(bytes(text)));
  doc.context.assign(s.ref, s.obj);
}

/** Rewrites groups and clip masks so Apple's renderer blends like the canvas. Returns counts. */
export function simplifyGroups(doc: PDFDocument): { masks: number; groups: number } {
  const n = (s: string) => PDFName.of(s);
  const streams = contentStreams(doc).filter((s) => readable(s.obj));
  const text = new Map<string, string>();
  for (const s of streams) { try { text.set(s.ref.toString(), latin1(decodePDFRawStream(s.obj).decode())); } catch { /* left alone */ } }

  // 1. Soft masks that are one solid shape → clipping paths, where they are set.
  const clipOf = new Map<string, string | null>(); // ExtGState → clip, cached per dict
  const maskForms = new Set<string>();
  const clipFor = (gsRef: unknown): string | null => {
    const key = String(gsRef);
    if (clipOf.has(key)) return clipOf.get(key)!;
    let clip: string | null = null;
    const gs = doc.context.lookup(gsRef as PDFRef);
    if (gs instanceof PDFDict) {
      const keys = gs.keys().map(String).filter((k) => k !== '/Type');
      const mask = gs.lookupMaybe(n('SMask'), PDFDict);
      if (keys.length === 1 && keys[0] === '/SMask' && mask && String(mask.get(n('S'))) === '/Alpha' && !mask.has(n('TR')) && !mask.has(n('BC'))) {
        const g = mask.get(n('G'));
        const form = g instanceof PDFRef ? doc.context.lookup(g) : undefined;
        if (form instanceof PDFRawStream && readable(form)) {
          const m = form.dict.lookupMaybe(n('Matrix'), PDFArray)?.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)) as M | undefined;
          try { clip = maskAsClip(latin1(decodePDFRawStream(form).decode()), m && m.length === 6 ? m : undefined); } catch { clip = null; }
        }
      }
    }
    clipOf.set(key, clip);
    return clip;
  };
  let masks = 0;
  for (const s of streams) {
    const src = text.get(s.ref.toString());
    const gsDict = s.res?.lookupMaybe(n('ExtGState'), PDFDict);
    if (!src || !gsDict || !src.includes(' gs')) continue;
    const toks = tokens(src);
    if (!toks) continue;
    const parts: string[] = [];
    let last = 0;
    for (let k = 1; k < toks.length; k++) {
      if (toks[k].t !== 'gs' || !toks[k - 1].t.startsWith('/')) continue;
      const clip = clipFor(gsDict.get(n(toks[k - 1].t.slice(1))));
      if (!clip) continue;
      parts.push(src.slice(last, toks[k - 1].s), ` ${clip} `);
      last = toks[k].e;
      masks++;
    }
    if (!parts.length) continue;
    parts.push(src.slice(last));
    const next = parts.join('');
    text.set(s.ref.toString(), next);
    rewrite(doc, s, next);
  }
  // Mask groups still in use elsewhere stay groups.
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && String(obj.get(n('Type'))) === '/Mask') maskForms.add(String(obj.get(n('G'))));
  }

  // 2 and 3. Where each form is drawn, and with what blending.
  type State = { bm: string; ca: number; CA: number; masked: boolean };
  const isNormal = (st: State) => (st.bm === '/Normal' || st.bm === '/Compatible') && st.ca >= 1 && st.CA >= 1 && !st.masked;
  const NORMAL: State = { bm: '/Normal', ca: 1, CA: 1, masked: false };
  const INHERITED_UNKNOWN: State = { bm: '?', ca: 0, CA: 0, masked: true };
  const isGroup = (r: PDFRef) => {
    const o = doc.context.lookup(r);
    return o instanceof PDFRawStream && o.dict.has(n('Group'));
  };
  const usesOf = (startNormal: (s: Stream) => boolean) => {
    const uses = new Map<string, boolean[]>();
    for (const s of streams) {
      const src = text.get(s.ref.toString());
      if (!src || !src.includes('Do')) continue;
      const toks = tokens(src);
      if (!toks) continue;
      const gsDict = s.res?.lookupMaybe(n('ExtGState'), PDFDict);
      const xo = s.res?.lookupMaybe(n('XObject'), PDFDict);
      const stack: State[] = [{ ...(startNormal(s) ? NORMAL : INHERITED_UNKNOWN) }];
      for (let k = 0; k < toks.length; k++) {
        const t = toks[k].t;
        const top = stack[stack.length - 1];
        if (t === 'q') stack.push({ ...top });
        else if (t === 'Q') { if (stack.length > 1) stack.pop(); }
        else if (t === 'gs') {
          const gs = gsDict?.lookup(n((toks[k - 1]?.t ?? '/').slice(1)));
          if (!(gs instanceof PDFDict)) { Object.assign(top, INHERITED_UNKNOWN); continue; }
          const bm = gs.get(n('BM'));
          if (bm) top.bm = String(bm instanceof PDFArray ? bm.get(0) : bm);
          const ca = gs.lookupMaybe(n('ca'), PDFNumber); if (ca) top.ca = ca.asNumber();
          const CA = gs.lookupMaybe(n('CA'), PDFNumber); if (CA) top.CA = CA.asNumber();
          const sm = gs.get(n('SMask')); if (sm !== undefined) top.masked = String(sm) !== '/None';
        } else if (t === 'Do') {
          const r = xo?.get(n((toks[k - 1]?.t ?? '/').slice(1)));
          if (r instanceof PDFRef) uses.set(r.toString(), [...(uses.get(r.toString()) ?? []), isNormal(top)]);
        }
      }
    }
    return uses;
  };
  // Pages and groups start Normal; a plain form starts the way it's drawn, which takes a few passes.
  const pageRefs = new Set(streams.filter((s) => !(String(s.obj.dict.get(n('Subtype'))) === '/Form' || s.obj.dict.has(n('PatternType')))).map((s) => s.ref.toString()));
  let plainNormal = new Set<string>();
  let uses = usesOf((s) => pageRefs.has(s.ref.toString()) || isGroup(s.ref) || plainNormal.has(s.ref.toString()));
  for (let pass = 0; pass < 4; pass++) {
    const next = new Set([...uses].filter(([, u]) => u.length && u.every(Boolean)).map(([r]) => r));
    if (next.size === plainNormal.size && [...next].every((r) => plainNormal.has(r))) break;
    plainNormal = next;
    uses = usesOf((s) => pageRefs.has(s.ref.toString()) || isGroup(s.ref) || plainNormal.has(s.ref.toString()));
  }

  let groups = 0;
  for (const s of streams) {
    const obj = doc.context.lookup(s.ref);
    if (!(obj instanceof PDFRawStream) || String(obj.dict.get(n('Subtype'))) !== '/Form') continue;
    const group = obj.dict.lookupMaybe(n('Group'), PDFDict);
    if (!group || String(group.get(n('S'))) !== '/Transparency' || group.has(n('CS'))) continue;
    if (maskForms.has(s.ref.toString())) continue;
    const used = uses.get(s.ref.toString()) ?? [];
    if (!used.length) continue; // an appearance stream or a mask: not ours to change
    const isolated = String(group.get(n('I'))) === 'true';
    const knockout = String(group.get(n('K'))) === 'true';
    let drop = !isolated && !knockout && used.every(Boolean);
    if (!drop) {
      const src = text.get(s.ref.toString());
      const drawn = src ? drawings(src) : null;
      if (drawn && drawn.length === 1) {
        drop = true;
        if (drawn[0].op === 'Do') {
          const target = s.res?.lookupMaybe(n('XObject'), PDFDict)?.lookup(n((drawn[0].name ?? '/').slice(1)));
          drop = target instanceof PDFRawStream && String(target.dict.get(n('Subtype'))) === '/Image';
        }
      }
    }
    if (!drop) continue;
    obj.dict.delete(n('Group'));
    groups++;
  }
  return { masks, groups };
}
