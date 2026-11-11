/**
 * Optional image compression, applied after tagging.
 *
 * File size in Figma's PDFs comes from photos placed at far more pixels than they're shown at, so
 * the main lever is downsampling to a target resolution (pixels per inch at the size the image is
 * actually placed), then re-encoding the JPEG. Transparency masks — Figma bakes rounded corners
 * into one — are resized alongside so they still line up.
 *
 * Images are replaced in place (same object, new data), so every reference to them, including the
 * Figure tags, stays valid. A re-encode is kept only if it is meaningfully smaller.
 *
 * Decoding and encoding JPEG is environment-specific, so it comes in as an ImageCodec: canvas in the
 * plugin UI, jpeg-js in the Node test harness.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { scanPlacements } from './content.ts';

export type QualityPreset = 'original' | 'print' | 'balanced' | 'small';

export const PRESETS: Record<QualityPreset, { label: string; detail: string; maxPpi: number | null; quality: number }> = {
  original: { label: 'Original', detail: 'Images exactly as Figma exports them', maxPpi: null, quality: 1 },
  print: { label: 'Print', detail: 'Up to 300 ppi, high-quality JPEG', maxPpi: 300, quality: 0.9 },
  balanced: { label: 'Balanced', detail: 'Up to 150 ppi — sharp on screen, much smaller', maxPpi: 150, quality: 0.82 },
  small: { label: 'Smallest', detail: 'Up to 96 ppi — for email and quick sharing', maxPpi: 96, quality: 0.7 },
};

export interface ImageCodec {
  /** Decodes a JPEG, resizes it to width × height, and re-encodes it at quality (0–1). */
  jpeg(bytes: Uint8Array, width: number, height: number, quality: number): Promise<Uint8Array>;
}

export interface ImageChange {
  name: string;
  from: [number, number];
  to: [number, number];
  before: number;
  after: number;
  /** Set when the image was left alone, with the reason. */
  kept?: string;
}

const n = (s: string) => PDFName.of(s);
const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
  return s;
};

/** The largest size, in points, each image XObject is painted at in one content stream. */
export function placedSizes(content: string): Map<string, { w: number; h: number }> {
  const out = new Map<string, { w: number; h: number }>();
  for (const p of scanPlacements(content)) {
    const prev = out.get(p.name);
    out.set(p.name, { w: Math.max(p.w, prev?.w ?? 0), h: Math.max(p.h, prev?.h ?? 0) });
  }
  return out;
}

/** Area-average downscale of one 8-bit channel (used for transparency masks). */
function resizeGray(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[yy * sw + xx];
      out[y * dw + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

function filterNames(dict: PDFDict): string[] {
  const f = dict.get(n('Filter'));
  if (f instanceof PDFName) return [f.asString()];
  if (f instanceof PDFArray) return f.asArray().map((x) => String(x));
  return [];
}

/** Three-component color: DeviceRGB, or an ICC profile with N 3. CMYK and gray are left alone. */
function isRgb(doc: PDFDocument, dict: PDFDict): boolean {
  const cs = dict.lookup(n('ColorSpace'));
  if (cs instanceof PDFName) return cs.asString() === '/DeviceRGB';
  if (cs instanceof PDFArray && String(cs.get(0)) === '/ICCBased') {
    const icc = doc.context.lookup(cs.get(1));
    const N = icc instanceof PDFRawStream ? icc.dict.lookupMaybe(n('N'), PDFNumber)?.asNumber() : undefined;
    return N === 3;
  }
  return false;
}

export async function compressImages(
  doc: PDFDocument,
  preset: QualityPreset,
  codec: ImageCodec,
  readContent: (page: ReturnType<PDFDocument['getPages']>[number]) => Uint8Array,
  onImage: (done: number, total: number) => void | Promise<void> = () => {},
): Promise<ImageChange[]> {
  const { maxPpi, quality } = PRESETS[preset];
  if (maxPpi === null) return [];

  // Where each image is placed, at its largest, across every page that uses it. Figma often
  // wraps a page's artwork in a form XObject (for a clip, mask or blend), so images are followed
  // into forms — and forms within forms — carrying the matrix down, to get their true placed size.
  const placed = new Map<string, { w: number; h: number; name: string }>();
  const visit = (content: string, resources: PDFDict | undefined, start: number[], depth: number) => {
    const xobjects = resources?.lookupMaybe(n('XObject'), PDFDict);
    if (!xobjects) return;
    for (const p of scanPlacements(content, start)) {
      const value = xobjects.get(n(p.name.slice(1)));
      if (!(value instanceof PDFRef)) continue;
      const obj = doc.context.lookup(value);
      if (!(obj instanceof PDFRawStream)) continue;
      const subtype = String(obj.dict.get(n('Subtype')));
      if (subtype === '/Image') {
        const k = value.toString();
        const prev = placed.get(k);
        placed.set(k, { w: Math.max(p.w, prev?.w ?? 0), h: Math.max(p.h, prev?.h ?? 0), name: p.name });
      } else if (subtype === '/Form' && depth < 8) {
        const m = obj.dict.lookupMaybe(n('Matrix'), PDFArray)?.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)) ?? [1, 0, 0, 1, 0, 0];
        const [a, b, c, d, e, f] = m;
        const [A, B, C, D, E, F] = p.ctm;
        const ctm = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
        let inner: Uint8Array;
        try { inner = decodePDFRawStream(obj).decode(); } catch { continue; }
        visit(latin1(inner), obj.dict.lookupMaybe(n('Resources'), PDFDict) ?? resources, ctm, depth + 1);
      }
    }
  };
  for (const page of doc.getPages()) visit(latin1(readContent(page)), page.node.Resources(), [1, 0, 0, 1, 0, 0], 0);

  const changes: ImageChange[] = [];
  let index = 0;
  for (const [refKey, size] of placed) {
    await onImage(index++, placed.size);
    const ref = [...doc.context.enumerateIndirectObjects()].find(([r]) => r.toString() === refKey)?.[0];
    if (!ref) continue;
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream) || String(stream.dict.get(n('Subtype'))) !== '/Image') continue;
    const dict = stream.dict;
    const w = dict.lookupMaybe(n('Width'), PDFNumber)?.asNumber() ?? 0;
    const h = dict.lookupMaybe(n('Height'), PDFNumber)?.asNumber() ?? 0;
    const before = stream.getContents().length;
    const change: ImageChange = { name: size.name, from: [w, h], to: [w, h], before, after: before };
    changes.push(change);

    if (filterNames(dict).join() !== '/DCTDecode') { change.kept = 'not a JPEG'; continue; }
    if (dict.lookupMaybe(n('BitsPerComponent'), PDFNumber)?.asNumber() !== 8 || !isRgb(doc, dict)) { change.kept = 'not 8-bit RGB'; continue; }

    // Pixels needed to show the image at maxPpi at its placed size; never upscale.
    const scale = Math.min(1, Math.max((size.w / 72) * maxPpi / w, (size.h / 72) * maxPpi / h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    const jpeg = await codec.jpeg(stream.getContents(), tw, th, quality);
    if (jpeg.length > before * 0.95) { change.kept = 'already as small as this setting allows'; continue; }

    // Resize the transparency mask to match, if there is one.
    const smaskRef = dict.get(n('SMask'));
    if (smaskRef instanceof PDFRef && (tw !== w || th !== h)) {
      const smask = doc.context.lookup(smaskRef);
      if (!(smask instanceof PDFRawStream)) { change.kept = 'unreadable transparency mask'; continue; }
      const sw = smask.dict.lookupMaybe(n('Width'), PDFNumber)?.asNumber() ?? 0;
      const sh = smask.dict.lookupMaybe(n('Height'), PDFNumber)?.asNumber() ?? 0;
      const bpc = smask.dict.lookupMaybe(n('BitsPerComponent'), PDFNumber)?.asNumber();
      const filters = filterNames(smask.dict).join();
      if (bpc !== 8 || (filters !== '/FlateDecode' && filters !== '') || smask.dict.has(n('DecodeParms'))) {
        change.kept = 'transparency mask in an unsupported format'; continue;
      }
      const alpha = decodePDFRawStream(smask).decode();
      if (alpha.length < sw * sh) { change.kept = 'truncated transparency mask'; continue; }
      const resized = resizeGray(alpha, sw, sh, tw, th);
      const maskDict = smask.dict.clone(doc.context);
      maskDict.set(n('Width'), PDFNumber.of(tw));
      maskDict.set(n('Height'), PDFNumber.of(th));
      const packed = doc.context.flateStream(resized, {});
      maskDict.set(n('Filter'), n('FlateDecode'));
      doc.context.assign(smaskRef, PDFRawStream.of(maskDict, packed.getContents()));
    }

    const imgDict = dict.clone(doc.context);
    imgDict.set(n('Width'), PDFNumber.of(tw));
    imgDict.set(n('Height'), PDFNumber.of(th));
    imgDict.delete(n('DecodeParms'));
    doc.context.assign(ref, PDFRawStream.of(imgDict, jpeg));
    change.to = [tw, th];
    change.after = jpeg.length;
  }
  return changes;
}
