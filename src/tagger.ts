/**
 * Rewrites Figma's PDF export into a properly tagged, screen-reader-accessible PDF.
 *
 * Figma already emits a marked, structured PDF: all artwork inside one `/Artifact BMC … EMC`,
 * then one `/Span <</MCID n>> BDC … EMC` per text node, each wired to a `/P → /Span` element
 * through the ParentTree. What it does not emit is meaning — every text run is a plain `/P`,
 * images sit inside the artifact with no alt text, and the reading order is Figma's emit order.
 *
 * So we do not build a structure tree from scratch and we do not touch the painting, except to
 * carve the image out of the artifact. We keep Figma's marked content exactly as it is, merge the
 * per-frame exports into one document, and build a new structure tree over the MCIDs that are
 * already there.
 */
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFObject,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import { fullText, type DocumentInput, type ImageItem, type ListItem, type TableItem, type TagResult, type TextItem, type TextRole } from './types.ts';
import { compressImages, type ImageCodec, type QualityPreset } from './compress.ts';
import { slimVectors } from './slim.ts';
import { overlap, scanPaints, scanPlacements } from './content.ts';
import { baseLang, linkDescription } from './checks.ts';

const n = (name: string) => PDFName.of(name);

/** Figma uses U+2028 for a soft line break inside a paragraph; PDF /ActualText uses \n. */
function normalizeText(s: string): string {
  return s.replace(/\r\n|\r|\u2028|\u2029/g, '\n').replace(/\s+/g, ' ').trim();
}

const loose = (s: string) => normalizeText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function decodeTextString(obj: unknown): string {
  if (obj instanceof PDFHexString || obj instanceof PDFString) return obj.decodeText();
  return '';
}

/**
 * Reads the per-MCID text out of a Figma export's own structure tree.
 * Figma's ParentTree has exactly one entry — key 0 — whose array is indexed by MCID.
 */
function readSourceMcids(src: PDFDocument): { normalized: string[]; actual: string[] } {
  const strRoot = src.catalog.lookupMaybe(n('StructTreeRoot'), PDFDict);
  if (!strRoot) throw new Error('This PDF has no StructTreeRoot — not a Figma tagged export?');
  const parentTree = strRoot.lookupMaybe(n('ParentTree'), PDFDict);
  if (!parentTree) throw new Error('StructTreeRoot has no ParentTree.');
  const nums = parentTree.lookupMaybe(n('Nums'), PDFArray);
  if (!nums || nums.size() < 2) throw new Error('ParentTree has no /Nums entries.');

  // /Nums is [key, value, key, value, …]. A single-frame export has one page, so one pair.
  const byMcid = nums.lookup(1, PDFArray);
  const normalized: string[] = [];
  const actual: string[] = [];
  for (let i = 0; i < byMcid.size(); i++) {
    const span = byMcid.lookupMaybe(i, PDFDict);
    const text = span ? decodeTextString(span.get(n('ActualText'))) : '';
    actual.push(text);
    normalized.push(normalizeText(text));
  }
  return { normalized, actual };
}

/** The /ActualText of each marked-content run in a Figma export, indexed by MCID. */
export async function readActualTexts(pdf: Uint8Array): Promise<string[]> {
  return readSourceMcids(await PDFDocument.load(pdf)).actual;
}

/** One marked-content run of Figma's export: its text, and the link annotation if it is a link. */
interface SourceRun {
  mcid: number;
  actual: string;
  /** Index into the source page's /Annots, for a run Figma tagged as a /Link. */
  annot?: number;
}

/**
 * Figma's export tags each text node as one /P holding its runs: usually a single /Span, but a
 * node with a hyperlink is split — /Span for the plain part, /Link (with an OBJR to the link
 * annotation) for the linked part. Reads those groups, so a text node is matched and tagged as a
 * whole and its links survive. MCIDs that no /P accounts for become groups of their own.
 */
function readSourceNodes(src: PDFDocument, actual: string[]): SourceRun[][] {
  const root = src.catalog.lookupMaybe(n('StructTreeRoot'), PDFDict);
  const annots = src.getPage(0).node.lookupMaybe(n('Annots'), PDFArray);
  const annotIndex = new Map<string, number>();
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const ref = annots!.get(i);
    if (ref instanceof PDFRef) annotIndex.set(ref.toString(), i);
  }

  const nodes: SourceRun[][] = [];
  const seen = new Set<number>();
  const kids = (d: PDFDict): unknown[] => {
    const k = d.get(n('K'));
    const arr = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
    return arr.map((x) => (x instanceof PDFRef ? src.context.lookup(x) : x));
  };
  // The MCIDs and annotation directly under one element.
  const content = (d: PDFDict): { mcids: number[]; annot?: number } => {
    const out: { mcids: number[]; annot?: number } = { mcids: [] };
    for (const k of kids(d)) {
      if (k instanceof PDFNumber) out.mcids.push(k.asNumber());
      else if (k instanceof PDFDict) {
        const type = String(k.get(n('Type')));
        if (type === '/MCR') out.mcids.push(k.lookup(n('MCID'), PDFNumber).asNumber());
        else if (type === '/OBJR') {
          const obj = k.get(n('Obj'));
          if (obj instanceof PDFRef && annotIndex.has(obj.toString())) out.annot = annotIndex.get(obj.toString());
        }
      }
    }
    return out;
  };
  const walk = (d: PDFDict) => {
    const children = kids(d).filter((k): k is PDFDict => k instanceof PDFDict && k.has(n('S')));
    const runs = children.filter((c) => ['/Span', '/Link'].includes(String(c.get(n('S')))));
    if (runs.length && runs.length === children.length) {
      const group: SourceRun[] = [];
      for (const r of runs) {
        const { mcids, annot } = content(r);
        for (const mcid of mcids) {
          if (seen.has(mcid) || mcid >= actual.length) continue;
          seen.add(mcid);
          group.push({ mcid, actual: actual[mcid], annot: String(r.get(n('S'))) === '/Link' ? annot : undefined });
        }
      }
      if (group.length) nodes.push(group);
      return;
    }
    for (const c of children) walk(c);
  };
  if (root) walk(root);
  for (let mcid = 0; mcid < actual.length; mcid++) if (!seen.has(mcid)) nodes.push([{ mcid, actual: actual[mcid] }]);
  return nodes;
}

/**
 * Points the page at a new content stream and deletes the one it replaces. pdf-lib writes every
 * registered object, referenced or not, so without the delete each rewrite leaves a dead copy of
 * the page's drawing code in the file — about 0.5 MB per rewrite on a photo-heavy page.
 */
function replacePageContent(doc: PDFDocument, page: { node: PDFPageLeafLike }, bytes: Uint8Array) {
  const previous = page.node.get(n('Contents'));
  page.node.set(n('Contents'), doc.context.register(doc.context.flateStream(bytes)));
  const old: unknown[] = previous instanceof PDFArray ? previous.asArray() : [previous];
  for (const ref of old) if (ref instanceof PDFRef) doc.context.delete(ref);
}

/** Decodes a page's content stream to bytes, whether it is one stream or an array of them. */
function readPageContent(page: { node: PDFPageLeafLike }): Uint8Array {
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFRawStream) {
    streams.push(contents);
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i);
      if (s instanceof PDFRawStream) streams.push(s);
    }
  }
  if (streams.length === 0) throw new Error('Page has no readable content stream.');
  // The streams of a Contents array are one program split into pieces. Join them with a newline
  // so an operator at the end of one can't fuse with an operand at the start of the next.
  const parts = streams.map((s) => decodePDFRawStream(s).decode());
  const total = parts.reduce((a, p) => a + p.length + 1, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.length;
    merged[off++] = 0x0a;
  }
  return merged;
}

interface PDFPageLeafLike {
  Contents(): unknown;
  get(key: PDFName): unknown;
  Resources(): PDFDict | undefined;
  set(key: PDFName, value: unknown): void;
}

const latin1 = {
  decode(bytes: Uint8Array): string {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + CH, bytes.length))));
    }
    return s;
  },
  encode(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  },
};

/** Names of the page's image XObjects, with their pixel sizes. */
function pageImages(page: { node: PDFPageLeafLike }): Map<string, { w: number; h: number }> {
  return resourceImages(page.node.Resources());
}

function resourceImages(resources: PDFDict | undefined): Map<string, { w: number; h: number }> {
  const out = new Map<string, { w: number; h: number }>();
  const xobjects = resources?.lookupMaybe(n('XObject'), PDFDict);
  if (!xobjects) return out;
  for (const [key] of xobjects.entries()) {
    // An image XObject is a stream, so its entries live on the stream's dictionary.
    const obj = xobjects.lookup(key);
    const xo = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!xo || String(xo.get(n('Subtype'))) !== '/Image') continue;
    out.set(key.asString(), {
      w: xo.lookupMaybe(n('Width'), PDFNumber)?.asNumber() ?? 0,
      h: xo.lookupMaybe(n('Height'), PDFNumber)?.asNumber() ?? 0,
    });
  }
  return out;
}

/**
 * Tags one image as a Figure: finds where it is painted and carves that one paint operation out
 * of Figma's page-wide artifact.
 *
 * Matching is by position first — the paint whose placed bounds best cover the Figma node's box —
 * so two photos of the same pixel size can't swap alt text. Pixel size is the fallback, then "the
 * only image on the page". Each paint is claimed once, so two items never wrap the same operator.
 *
 * Figma wraps every bit of artwork in one `/Artifact BMC … EMC`, which tells a screen reader to
 * skip all of it. We close the artifact immediately before the paint, wrap the `Do` in its own
 * marked-content sequence, then reopen the artifact. Begin/end counts stay balanced, and nothing
 * about the painting changes.
 */
function tagImage(
  doc: PDFDocument,
  page: { node: PDFPageLeafLike },
  item: ImageItem,
  mcid: number,
  claimed: Set<string>,
): string | null {
  const content = latin1.decode(readPageContent(page));
  const carved = carveImage({ id: 'page', content, images: pageImages(page), ctm: [1, 0, 0, 1, 0, 0] }, item, mcid, claimed);
  if (!carved) return null;
  replacePageContent(doc, page, latin1.encode(carved.content));
  return carved.name;
}

/** One content stream to tag in: a page's, or a form XObject's (with the matrix it's drawn at). */
interface Surface { id: string; content: string; images: Map<string, { w: number; h: number }>; ctm: number[] }

/** tagImage on any content stream: the rewritten content, or null when the image isn't in it. */
function carveImage(s: Surface, item: ImageItem, mcid: number, claimed: Set<string>): { content: string; name: string } | null {
  const { content, images } = s;
  const paints = scanPlacements(content, s.ctm).filter((p) => images.has(p.name) && !claimed.has(`${s.id}:${p.name}#${p.occurrence}`));
  if (!paints.length) return null;

  const area = Math.max(1, (item.bbox[2] - item.bbox[0]) * (item.bbox[3] - item.bbox[1]));
  const byPosition = paints
    .map((p) => ({ p, cover: overlap(p.bounds, item.bbox) / area }))
    .sort((a, b) => b.cover - a.cover)[0];
  const bySize = paints.find((p) => {
    const px = images.get(p.name)!;
    return px.w === item.naturalWidth && px.h === item.naturalHeight;
  });
  const pick =
    byPosition.cover >= 0.5 ? byPosition.p : bySize ?? (paints.length === 1 ? paints[0] : null);
  if (!pick) return null;

  // The pick-th `Do` of this name, in stream order — the same count the scanner kept.
  const name = pick.name.replace('/', '\\/');
  const re = new RegExp('(^|\\s)' + name + '\\s+Do\\b', 'g');
  let m: RegExpExecArray | null = null;
  for (let k = 0; k <= pick.occurrence; k++) m = re.exec(content);
  if (!m) return null;

  const at = m.index + m[1].length;
  const end = m.index + m[0].length;
  const rewritten =
    content.slice(0, at) +
    `EMC\n/Figure <</MCID ${mcid}>> BDC\n` + content.slice(at, end) + `\nEMC\n/Artifact BMC\n` +
    content.slice(end);
  claimed.add(`${s.id}:${pick.name}#${pick.occurrence}`);
  return { content: rewritten, name: pick.name };
}

/**
 * Tags a vector graphic — a logo — as a Figure. Figma draws a vector or boolean layer as path
 * operations inside its page-wide artifact, so we find the paths that land inside the layer's box
 * and wrap that run of the content stream, the same way tagImage wraps a single `Do`.
 *
 * The run must be contiguous and contain no other marked content or text, or we leave it alone
 * rather than risk breaking the structure.
 */
function tagGraphic(doc: PDFDocument, page: { node: PDFPageLeafLike }, item: ImageItem, mcid: number): boolean {
  const content = latin1.decode(readPageContent(page));
  const rewritten = carveGraphic(content, item, mcid);
  if (rewritten === null) return false;
  replacePageContent(doc, page, latin1.encode(rewritten));
  return true;
}

function carveGraphic(content: string, item: ImageItem, mcid: number, ctm?: number[]): string | null {
  const span = planGraphic(content, item, ctm);
  if (!span) return null;
  const { start, end } = span;
  return content.slice(0, start) +
    `EMC\n/Figure <</MCID ${mcid}>> BDC\n` + content.slice(start, end) + `\nEMC\n/Artifact BMC\n` +
    content.slice(end);
}

/**
 * When a frame has an effect on all of its art (opacity, a blend), Figma draws that art inside one
 * transparency group: a form XObject painted once, inside the page's artifact. Images and logos are
 * then in the form's own content stream, not the page's. A form found here can carry its own marked
 * content — PDF/UA allows it — through a /StructParents entry of its own and MCRs naming the stream.
 */
interface FormSurface extends Surface {
  ref: PDFRef;
  stream: PDFRawStream;
  /** The stream that paints this form with one `Do`. */
  parent: { kind: 'page' } | { kind: 'form'; form: FormSurface };
  name: string;
  /** Figures inside, indexed by MCID within this form. */
  elems: PDFRef[];
  /** Content is wrapped as an artifact and its Do taken out of the parent's artifact. */
  opened: boolean;
}

/** Form XObjects painted exactly once by `content`, with the matrix each is drawn at. */
function formsIn(ctx: PDFContext, content: string, resources: PDFDict | undefined, ctm: number[]): Array<{ name: string; ref: PDFRef; stream: PDFRawStream; ctm: number[] }> {
  const xobjects = resources?.lookupMaybe(n('XObject'), PDFDict);
  if (!xobjects) return [];
  const out: Array<{ name: string; ref: PDFRef; stream: PDFRawStream; ctm: number[] }> = [];
  const placed = scanPlacements(content, ctm);
  for (const [key, value] of xobjects.entries()) {
    const ref = value instanceof PDFRef ? value : undefined;
    const stream = ref ? ctx.lookup(ref) : undefined;
    if (!ref || !(stream instanceof PDFRawStream) || String(stream.dict.get(n('Subtype'))) !== '/Form') continue;
    const at = placed.filter((p) => p.name === key.asString());
    if (at.length !== 1) continue;
    const m = stream.dict.lookupMaybe(n('Matrix'), PDFArray)?.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0));
    const [a, b, c, d, e, f] = m && m.length === 6 ? m : [1, 0, 0, 1, 0, 0];
    const [A, B, C, D, E, F] = at[0].ctm;
    out.push({ name: key.asString(), ref, stream, ctm: [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F] });
  }
  return out;
}

/** Depth of marked content (BMC/BDC minus EMC) just before `at`. */
function markedDepth(content: string, at: number): number {
  let depth = 0;
  for (const m of content.slice(0, at).matchAll(/(^|\s)(BMC|BDC|EMC)(?=\s|$)/g)) depth += m[2] === 'EMC' ? -1 : 1;
  return depth;
}

/** Replaces a form XObject's content, keeping its dictionary (BBox, Group, Resources…). */
function writeForm(ctx: PDFContext, form: FormSurface) {
  const keep: Record<string, PDFObject> = {};
  for (const [k, v] of form.stream.dict.entries()) {
    const key = k.asString().slice(1);
    if (key !== 'Filter' && key !== 'DecodeParms' && key !== 'Length') keep[key] = v;
  }
  const next = ctx.flateStream(latin1.encode(form.content), keep);
  ctx.assign(form.ref, next);
  form.stream = next as unknown as PDFRawStream;
}

/**
 * Where a vector graphic is drawn in the content stream: the run of paths inside its box, or null
 * when there's no clean run to wrap. Separate from the rewrite so a chart can be checked before its
 * labels are made artifacts — a chart that can't be tagged must keep its labels as text.
 */
function planGraphic(content: string, item: ImageItem, ctm?: number[]): { start: number; end: number } | null {
  // A chart is drawn in many pieces, and other artwork (a source line, a card edge) can be painted
  // between them. For a chart, wrap everything from its first piece to its last: artwork that gets
  // pulled in was an artifact anyway, and is now part of a figure that has alt text.
  const loose = !!item.chart || !!item.diagram;
  const paints = scanPaints(content, ctm);
  const [x0, y0, x1, y1] = item.bbox;
  const tol = 2 + 0.02 * Math.max(x1 - x0, y1 - y0);
  const within = (b: [number, number, number, number]) =>
    b[0] >= x0 - tol && b[1] >= y0 - tol && b[2] <= x1 + tol && b[3] <= y1 + tol;
  const hits = paints.map((p, i) => (p.kind !== 'image' && p.mcDepth === 1 && within(p.bounds) ? i : -1)).filter((i) => i >= 0);
  if (!hits.length) return null;
  if (!loose && hits.some((v, k) => k > 0 && v !== hits[k - 1] + 1)) return null; // not one contiguous drawing
  if (loose && paints.slice(hits[0], hits[hits.length - 1] + 1).some((p) => p.mcDepth !== 1)) return null;

  const start = paints[hits[0]].start;
  const end = paints[hits[hits.length - 1]].end;
  if (/(^|\s)(BT|ET|BMC|BDC|EMC)(\s|$)/.test(content.slice(start, end))) return null;
  return { start, end };
}

/**
 * Turns decorative text into artifacts, so screen readers skip it.
 *
 * Each of Figma's text runs is `/Span <</MCID n>> BDC … EMC`. For decorative ones we swap the
 * opening for `/Artifact BMC`; the EMC still closes it. The remaining runs are renumbered 0…n-1 so
 * the ParentTree has no holes. Returns old MCID → new MCID, or -1 for runs that became artifacts.
 */
function artifactText(doc: PDFDocument, page: { node: PDFPageLeafLike }, decorative: Set<number>): number[] {
  const content = latin1.decode(readPageContent(page));
  const olds = [...new Set([...content.matchAll(/\/MCID\s+(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const remap: number[] = [];
  let next = 0;
  for (const old of olds) remap[old] = decorative.has(old) ? -1 : next++;

  const rewritten = content.replace(/\/(\w+)\s*<<\s*\/MCID\s+(\d+)\s*>>\s*BDC/g, (_whole, tag: string, digits: string) => {
    const old = Number(digits);
    return decorative.has(old) ? '/Artifact BMC' : `/${tag} <</MCID ${remap[old]}>> BDC`;
  });
  replacePageContent(doc, page, latin1.encode(rewritten));
  return remap;
}

function xmpPacket(title: string, language: string): string {
  const esc = (s: string) =>
    s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>
      <dc:language><rdf:Bag><rdf:li>${esc(language)}</rdf:li></rdf:Bag></dc:language>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
      <pdfuaid:part>1</pdfuaid:part>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export interface Progress {
  phase: 'tag' | 'compress' | 'save';
  done: number;
  total: number;
}

export interface BuildOptions {
  /** Image quality preset; 'original' (the default) leaves images exactly as Figma exported them. */
  quality?: QualityPreset;
  /** Required for any preset other than 'original'. */
  codec?: ImageCodec;
  /** Called before each step. Awaited, so a UI can repaint between steps. */
  onProgress?: (p: Progress) => void | Promise<void>;
}

/** "01" → Decimal, "IV" → UpperRoman, "•" → Disc… the /ListNumbering a list's labels imply. */
function listNumbering(labels: string[]): string {
  if (!labels.length) return 'None';
  const all = (re: RegExp) => labels.every((l) => re.test(l.trim()));
  if (all(/^\(?\d+[.)]?$/)) return 'Decimal';
  if (all(/^\(?[IVXLC]+[.)]?$/)) return 'UpperRoman';
  if (all(/^\(?[ivxlc]+[.)]?$/)) return 'LowerRoman';
  if (all(/^\(?[A-Z][.)]?$/)) return 'UpperAlpha';
  if (all(/^\(?[a-z][.)]?$/)) return 'LowerAlpha';
  return 'Disc';
}

export async function buildTaggedPdf(input: DocumentInput, options: BuildOptions = {}): Promise<TagResult> {
  // An empty language would write /Lang (), which PDF/UA rejects.
  const language = input.language.trim() || 'en-US';
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const warnings: string[] = [];
  /** /Lang for a passage in another language than the document's, so a screen reader switches voice. */
  const langOf = (item?: TextItem): Record<string, unknown> =>
    item?.lang && baseLang(item.lang) !== baseLang(language) ? { Lang: PDFString.of(item.lang) } : {};
  const report: TagResult['report'] = { pages: [], warnings, images: [], bookmarks: 0 };

  // Forward-declare the roots so children can point at their parents as we go.
  const structTreeRootRef = ctx.nextRef();
  const documentElemRef = ctx.nextRef();

  const parentTreeNums = ctx.obj([]) as PDFArray;
  // Link annotations get ParentTree keys after the pages' keys (0…pages-1).
  const annotEntries: Array<[number, PDFRef]> = [];
  // Form XObjects holding figures get ParentTree keys of their own, from the same counter.
  const formEntries: Array<[number, PDFArray]> = [];
  let nextKey = input.pages.length;
  const sectionRefs: PDFRef[] = [];
  const headings: Array<{ level: number; title: string; page: PDFRef; top: number }> = [];
  const pageRefs: PDFRef[] = [];

  // Where a table-of-contents entry can jump to: a heading (H1–H3) with the same words, or a
  // frame with that name. Collected up front, since a ToC comes before the pages it points at.
  const targets = new Map<string, { pageIndex: number; top?: number; title: string }>();
  input.pages.forEach((p, pageIndex) => {
    for (const it of p.items)
      if (it.kind === 'text' && /^H[1-3]$/.test(it.role) && !targets.has(loose(it.text)))
        targets.set(loose(it.text), { pageIndex, top: it.bbox?.[3], title: normalizeText(it.text) });
  });
  input.pages.forEach((p, pageIndex) => {
    if (!targets.has(loose(p.name))) targets.set(loose(p.name), { pageIndex, title: p.name });
  });
  const pendingDests: Array<{ annot: PDFDict; pageIndex: number; top?: number }> = [];

  const progress = options.onProgress ?? (() => {});
  for (let pageIndex = 0; pageIndex < input.pages.length; pageIndex++) {
    await progress({ phase: 'tag', done: pageIndex, total: input.pages.length });
    const pageInput = input.pages[pageIndex];
    const src = await PDFDocument.load(pageInput.pdf);
    const { actual: sourceActual } = readSourceMcids(src);
    const sourceNodes = readSourceNodes(src, sourceActual);

    const [copied] = await doc.copyPages(src, [0]);
    doc.addPage(copied);
    const pageRef = copied.ref;
    pageRefs[pageIndex] = pageRef;
    const structParents = pageIndex;
    copied.node.set(n('StructParents'), PDFNumber.of(structParents));
    copied.node.set(n('Tabs'), n('S'));
    const annots = copied.node.lookupMaybe(n('Annots'), PDFArray);

    const sectionRef = ctx.nextRef();
    sectionRefs.push(sectionRef);

    // Pass 1: match every text item — loose, or inside a table or list — to the text node Figma
    // exported for it. A node is all of its runs together; a node whose runs were split (a link)
    // still matches as a whole. Nothing is built yet, because marking text decorative renumbers.
    const nodeOf = new Map<TextItem, SourceRun[]>();
    const usedNodes = new Set<SourceRun[]>();
    const unmatched: string[] = [];
    const missing: TextItem[] = [];
    /** Matched by layer order, not by text: Figma left their text out (Arabic, Hebrew…). */
    const fromLayer = new Set<TextItem>();
    const nodeText = (runs: SourceRun[]) => normalizeText(runs.map((r) => r.actual).join(''));
    const match = (item: TextItem) => {
      const wanted = normalizeText(item.text);
      const free = sourceNodes.filter((g) => !usedNodes.has(g));
      // Exact first; then loose — ignoring case, punctuation and spacing — so a small mismatch
      // between the layer's characters and Figma's PDF text doesn't drop the item.
      let found = free.find((g) => nodeText(g) === wanted);
      if (!found) {
        const key = loose(item.text);
        found = key ? free.find((g) => loose(nodeText(g)) === key) : undefined;
      }
      if (!found) return void missing.push(item);
      usedNodes.add(found);
      nodeOf.set(item, found);
    };
    const textsIn = (item: (typeof pageInput.items)[number]): TextItem[] =>
      item.kind === 'text' ? [item, ...(item.joined ?? []).map((j) => j.item)]
      : item.kind === 'table' ? [...(item.caption ? [item.caption] : []), ...item.rows.flat(2)]
      : item.kind === 'list' ? item.items.flatMap((e) => [...(e.label ? [e.label] : []), ...e.body])
      : [];
    for (const item of pageInput.items) for (const t of textsIn(item)) match(t);
    // Figma's export leaves some text without its words (right-to-left scripts like Arabic and
    // Hebrew, shaped at export): the runs are there, their text is empty. The layers that found no
    // match are those, in the order Figma draws them — so pair them in layer order, and give each
    // the layer's own characters, which are in reading order.
    const blank = sourceNodes.filter((g) => !usedNodes.has(g) && !nodeText(g));
    if (missing.length && missing.length === blank.length && missing.every((m) => m.layerIndex !== undefined)) {
      [...missing].sort((a, b) => a.layerIndex! - b.layerIndex!).forEach((m, k) => {
        usedNodes.add(blank[k]);
        nodeOf.set(m, blank[k]);
        fromLayer.add(m);
      });
      missing.length = 0;
    }
    for (const m of missing) unmatched.push(m.text.slice(0, 60));

    // Charts first. An image or logo inside a chart is part of it (the chart's alt speaks for it),
    // so it isn't carved out separately — that would split the chart's drawing. And a chart that
    // can't be found in the drawing keeps its labels as text, or a screen reader would get nothing.
    const charts = pageInput.items.filter((i): i is ImageItem => i.kind === 'image' && !!i.chart);
    const center = (b: [number, number, number, number]) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const insideChart = new Set(pageInput.items.filter((i): i is ImageItem => i.kind === 'image' && !i.chart && charts.some((c) => {
      const [cx, cy] = center(i.bbox);
      return cx >= c.bbox[0] && cx <= c.bbox[2] && cy >= c.bbox[1] && cy <= c.bbox[3];
    })));
    const original = latin1.decode(readPageContent(copied));

    // Transparency groups this page paints (see FormSurface): where images and logos may be drawn.
    const forms: FormSurface[] = [];
    const walkForms = (content: string, resources: PDFDict | undefined, ctm: number[], parent: FormSurface['parent'], depth: number) => {
      for (const f of formsIn(ctx, content, resources, ctm)) {
        const inner = latin1.decode(decodePDFRawStream(f.stream).decode());
        // A form with marked content of its own is structured already; leave it alone.
        if (/(^|\s)(BMC|BDC)(\s|$)/.test(inner)) continue;
        const res = f.stream.dict.lookupMaybe(n('Resources'), PDFDict) ?? resources;
        const form: FormSurface = { id: `form${f.ref.objectNumber}`, content: inner, images: resourceImages(res), ctm: f.ctm, ref: f.ref, stream: f.stream, parent, name: f.name, elems: [], opened: false };
        forms.push(form);
        if (depth < 3) walkForms(inner, res, f.ctm, { kind: 'form', form }, depth + 1);
      }
    };
    walkForms(original, copied.node.Resources(), [1, 0, 0, 1, 0, 0], { kind: 'page' }, 0);
    const asArtifact = (c: string) => `/Artifact BMC\n${c}\nEMC\n`;
    /** Wraps a form's content as an artifact and takes its Do out of the parent's artifact. */
    const openForm = (form: FormSurface): boolean => {
      if (form.opened) return true;
      const doRe = new RegExp('(^|\\s)' + form.name.replace('/', '\\/') + '\\s+Do\\b', 'g');
      const edit = (content: string): string | null => {
        const hits = [...content.matchAll(doRe)];
        if (hits.length !== 1) return null;
        const at = hits[0].index! + hits[0][1].length;
        if (markedDepth(content, at) !== 1) return null;
        const end = hits[0].index! + hits[0][0].length;
        return content.slice(0, at) + `EMC\n${content.slice(at, end)}\n/Artifact BMC\n` + content.slice(end);
      };
      if (form.parent.kind === 'page') {
        const next = edit(latin1.decode(readPageContent(copied)));
        if (next === null) return false;
        replacePageContent(doc, copied, latin1.encode(next));
      } else {
        const up = form.parent.form;
        if (!openForm(up)) return false;
        const next = edit(up.content);
        if (next === null) return false;
        up.content = next;
        writeForm(ctx, up);
      }
      form.content = asArtifact(form.content);
      form.opened = true;
      return true;
    };
    /** Tags an image or logo inside one of the page's forms. */
    const tagInForm = (item: ImageItem): { form: FormSurface; mcid: number } | null => {
      for (const form of forms) {
        const wrapped = form.opened ? form.content : asArtifact(form.content);
        const mcid = form.elems.length;
        const carved = item.vector
          ? carveGraphic(wrapped, item, mcid, form.ctm)
          : carveImage({ ...form, content: wrapped }, item, mcid, claimedPaints)?.content ?? null;
        if (carved === null || !openForm(form)) continue;
        form.content = carved;
        writeForm(ctx, form);
        return { form, mcid };
      }
      return null;
    };
    const inAnyForm = (c: ImageItem) => forms.some((f) => !!planGraphic(f.opened ? f.content : asArtifact(f.content), c, f.ctm));
    const lostCharts = new Set(charts.filter((c) => !planGraphic(original, c) && !inAnyForm(c)));
    // A diagram's art is found the way any image or graphic is; checked first (on copies, nothing
    // is changed) so that art that can't be found keeps its labels as text.
    const findable = (i: ImageItem) => {
      if (i.vector) return !!planGraphic(original, i) || inAnyForm(i);
      if (carveImage({ id: 'page', content: original, images: pageImages(copied), ctm: [1, 0, 0, 1, 0, 0] }, i, 0, new Set())) return true;
      return forms.some((f) => !!carveImage({ ...f, content: f.opened ? f.content : asArtifact(f.content) }, i, 0, new Set()));
    };
    const lostDiagrams = pageInput.items.filter((i): i is ImageItem => i.kind === 'image' && !!i.diagram && !i.chart && !findable(i));
    const keepLabels = new Set([...lostCharts, ...lostDiagrams].flatMap((c) => c.labels ?? []));
    for (const c of lostCharts)
      warnings.push(`${pageInput.name}: couldn't find a chart in Figma's PDF for “${c.nodeId}”, so its labels are read as text instead of its alt text.`);
    for (const c of lostDiagrams)
      warnings.push(`${pageInput.name}: couldn't find a diagram in Figma's PDF for “${c.nodeId}”, so its labels are read as text instead of its alt text.`);

    // Decorative text leaves the structure entirely: its marked content becomes an artifact. A
    // node holding a link can't: its annotation must stay tagged, so it's read as text instead.
    const isLink = (runs: SourceRun[]) => runs.some((r) => r.annot !== undefined);
    const decorative = new Set<number>();
    for (const [item, runs] of nodeOf)
      if (item.role === 'Artifact' && !keepLabels.has(item.nodeId)) {
        if (isLink(runs)) warnings.push(`${pageInput.name}: “${item.text.slice(0, 40)}” has a link, so it is read as text, not skipped.`);
        else for (const r of runs) decorative.add(r.mcid);
      }
    const remap = decorative.size ? artifactText(doc, copied, decorative) : sourceActual.map((_, i) => i);

    const elemByMcid: Array<PDFRef | undefined> = new Array(sourceActual.length - decorative.size);
    const claimedPaints = new Set<string>();
    let figures = 0, tables = 0, lists = 0, links = 0;

    const actualText = (s: string) => (s ? { ActualText: PDFHexString.fromText(s.replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ')) } : {});
    const elem = (role: string, parent: PDFRef, k: unknown, extra: Record<string, unknown> = {}): PDFRef => {
      const ref = ctx.nextRef();
      ctx.assign(ref, ctx.obj({ Type: 'StructElem', S: role, P: parent, Pg: pageRef, ...(k === undefined ? {} : { K: k }), ...extra } as never));
      return ref;
    };

    /**
     * Tags one Figma text node as `role` under `parent`. A single run becomes the element itself,
     * carrying Figma's exact text as /ActualText (without it, assistive tech rebuilds the string
     * from glyph runs and mangles line breaks). Several runs become /Span and /Link children, each
     * link tied to its annotation through an OBJR and a ParentTree entry of its own.
     */
    const emitText = (runs: SourceRun[], role: string, parent: PDFRef, extra: Record<string, unknown> = {}): PDFRef | null => {
      const live = runs.filter((r) => remap[r.mcid] >= 0);
      if (!live.length) return null;
      if (live.length === 1 && live[0].annot === undefined) {
        const mcid = remap[live[0].mcid];
        const ref = elem(role, parent, mcid, { ...actualText(live[0].actual), ...extra });
        elemByMcid[mcid] = ref;
        return ref;
      }
      const ref = ctx.nextRef();
      const children: PDFRef[] = [];
      for (const r of live) {
        const mcid = remap[r.mcid];
        const annotRef = r.annot !== undefined ? annots?.get(r.annot) : undefined;
        if (annotRef instanceof PDFRef) {
          const key = nextKey++;
          const objr = ctx.obj({ Type: 'OBJR', Obj: annotRef, Pg: pageRef });
          const link = elem('Link', ref, [mcid, objr], actualText(r.actual));
          const annot = ctx.lookup(annotRef, PDFDict);
          annot.set(n('StructParent'), PDFNumber.of(key));
          // Its name in a screen reader's links list: a web address in words (see linkDescription).
          if (!annot.has(n('Contents'))) annot.set(n('Contents'), PDFHexString.fromText(linkDescription(r.actual)));
          annotEntries.push([key, link]);
          elemByMcid[mcid] = link;
          children.push(link);
          links++;
        } else {
          const span = elem('Span', ref, mcid, actualText(r.actual));
          elemByMcid[mcid] = span;
          children.push(span);
        }
      }
      ctx.assign(ref, ctx.obj({ Type: 'StructElem', S: role, P: parent, Pg: pageRef, K: children, ...extra } as never));
      return ref;
    };
    /** Several text items as one element: inline when there is one, else as /P children. */
    const emitGroup = (items: TextItem[], role: string, parent: PDFRef, extra: Record<string, unknown> = {}): PDFRef => {
      const nodes = items.map((i) => nodeOf.get(i)).filter((g): g is SourceRun[] => !!g);
      const matched = items.filter((i) => nodeOf.has(i));
      if (nodes.length === 1) {
        const own = { ...langOf(matched[0]), ...extra };
        return emitText(nodes[0], role, parent, own) ?? elem(role, parent, undefined, own);
      }
      const ref = ctx.nextRef();
      const kids = matched.map((i) => emitText(nodeOf.get(i)!, 'P', ref, langOf(i))).filter((r): r is PDFRef => !!r);
      ctx.assign(ref, ctx.obj({ Type: 'StructElem', S: role, P: parent, Pg: pageRef, ...(kids.length ? { K: kids } : {}), ...extra } as never));
      return ref;
    };

    const emitTable = (t: TableItem): PDFRef => {
      const table = ctx.nextRef();
      const rows = t.rows.map((row, r) => {
        const tr = ctx.nextRef();
        const cells = row.map((cell, c) => {
          const heads = t.headerRow ? t.headerRows ?? 1 : 0;
          const header = r < heads || (t.headerCol && c === 0);
          const scope = r < heads ? 'Column' : 'Row';
          return emitGroup(cell, header ? 'TH' : 'TD', tr, header ? { A: ctx.obj({ O: 'Table', Scope: scope }) } : {});
        });
        ctx.assign(tr, ctx.obj({ Type: 'StructElem', S: 'TR', P: table, Pg: pageRef, K: cells }));
        return tr;
      });
      const caption = t.caption && nodeOf.has(t.caption) ? emitText(nodeOf.get(t.caption)!, 'Caption', table, langOf(t.caption)) : null;
      ctx.assign(table, ctx.obj({ Type: 'StructElem', S: 'Table', P: sectionRef, Pg: pageRef, K: caption ? [caption, ...rows] : rows }));
      tables++;
      return table;
    };

    /**
     * A table-of-contents entry that jumps to its section: LBody → Link → the entry's text, plus a
     * link annotation over the entry (number and title) whose destination is the matching heading.
     * The destination is filled in once every page exists.
     */
    const emitTocLink = (e: ListItem['items'][number], li: PDFRef, target: { pageIndex: number; top?: number; title: string }): PDFRef => {
      const lbody = ctx.nextRef();
      const link = emitGroup(e.body, 'Link', lbody);
      const boxes = [...(e.label?.bbox ? [e.label.bbox] : []), ...e.body.flatMap((b) => (b.bbox ? [b.bbox] : []))];
      if (boxes.length) {
        const rect = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
        const key = nextKey++;
        const annot = ctx.obj({
          Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], F: 4, P: pageRef,
          StructParent: key, Contents: PDFHexString.fromText(`Go to ${target.title}`),
        }) as PDFDict;
        const annotRef = ctx.register(annot);
        let list = copied.node.lookupMaybe(n('Annots'), PDFArray);
        if (!list) { list = ctx.obj([]) as PDFArray; copied.node.set(n('Annots'), list); }
        list.push(annotRef);
        // The Link element holds the entry's text and the annotation.
        const dict = ctx.lookup(link, PDFDict);
        const k = dict.get(n('K'));
        const kids = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
        dict.set(n('K'), ctx.obj([...kids, ctx.obj({ Type: 'OBJR', Obj: annotRef, Pg: pageRef })] as never));
        annotEntries.push([key, link]);
        pendingDests.push({ annot, pageIndex: target.pageIndex, top: target.top });
        links++;
      }
      ctx.assign(lbody, ctx.obj({ Type: 'StructElem', S: 'LBody', P: li, Pg: pageRef, K: [link] }));
      return lbody;
    };

    const emitList = (l: ListItem): PDFRef => {
      const list = ctx.nextRef();
      const labels = l.items.flatMap((e) => (e.label ? [e.label.text] : []));
      const entries = l.items.map((e) => {
        const li = ctx.nextRef();
        const kids: PDFRef[] = [];
        if (e.label && nodeOf.has(e.label)) {
          const lbl = emitText(nodeOf.get(e.label)!, 'Lbl', li, langOf(e.label));
          if (lbl) kids.push(lbl);
        }
        const target = targets.get(loose(e.body.map((b) => b.text).join(' ')));
        if (target && target.pageIndex !== pageIndex && e.body.every((b) => nodeOf.has(b))) {
          kids.push(emitTocLink(e, li, target));
        } else {
          kids.push(emitGroup(e.body, 'LBody', li));
        }
        ctx.assign(li, ctx.obj({ Type: 'StructElem', S: 'LI', P: list, Pg: pageRef, K: kids }));
        return li;
      });
      const numbering = listNumbering(labels.length === l.items.length ? labels : []);
      ctx.assign(list, ctx.obj({ Type: 'StructElem', S: 'L', P: sectionRef, Pg: pageRef, K: entries, A: ctx.obj({ O: 'List', ListNumbering: numbering }) }));
      lists++;
      return list;
    };

    // Pass 2: build elements in the designer's order — that order becomes the reading order.
    const childRefs: PDFRef[] = [];
    const frameHeight = copied.getHeight();
    for (const item of pageInput.items) {
      if (item.kind === 'text') {
        const own = nodeOf.get(item);
        if (!own) continue;
        // Joined layers (a split heading's next line, a drop cap's paragraph) are read inside this
        // element, with what goes between them (a space, or nothing) at the end of the piece before.
        let runs = own;
        for (const j of item.joined ?? []) {
          const more = nodeOf.get(j.item);
          if (!more) continue;
          const last = runs[runs.length - 1];
          runs = [...runs.slice(0, -1), { ...last, actual: last.actual + j.sep }, ...more];
        }
        // Letters typed apart ("S P E C T E R") are read as the word they spell.
        const spoken = fromLayer.has(item) ? actualText(item.spoken ?? fullText(item))
          : item.spoken && runs.length === 1 && runs[0].annot === undefined ? actualText(item.spoken) : {};
        const ref = emitText(runs, item.role === 'Artifact' ? 'P' : item.role, sectionRef, { ...langOf(item), ...spoken });
        if (!ref) continue;
        childRefs.push(ref);
        const level = /^H([1-3])$/.exec(item.role)?.[1];
        if (level) headings.push({ level: Number(level), title: normalizeText(item.spoken ?? fullText(item)), page: pageRef, top: item.bbox ? item.bbox[3] : frameHeight });
      } else if (item.kind === 'table') {
        childRefs.push(emitTable(item));
      } else if (item.kind === 'list') {
        childRefs.push(emitList(item));
      } else {
        if (insideChart.has(item) || lostCharts.has(item)) continue;
        const mcid = elemByMcid.length;
        const tagged = item.vector ? tagGraphic(doc, copied, item, mcid) : !!tagImage(doc, copied, item, mcid, claimedPaints);
        const inForm = tagged ? null : tagInForm(item);
        if (inForm) {
          // Marked content in a form: the element points at it with an MCR naming the stream.
          const mcr = ctx.obj({ Type: 'MCR', Pg: pageRef, Stm: inForm.form.ref, MCID: inForm.mcid });
          const ref = elem('Figure', sectionRef, mcr, { Alt: PDFHexString.fromText(item.alt), A: ctx.obj({ O: 'Layout', BBox: item.bbox }) });
          inForm.form.elems[inForm.mcid] = ref;
          childRefs.push(ref);
          figures++;
          continue;
        }
        if (!tagged) {
          warnings.push(`${pageInput.name}: couldn't find ${item.chart ? 'a chart' : 'an image'} in Figma's PDF for “${item.nodeId}”, so its alt text was not added.`);
          continue;
        }
        elemByMcid.length = mcid + 1;
        const ref = elem('Figure', sectionRef, mcid, { Alt: PDFHexString.fromText(item.alt), A: ctx.obj({ O: 'Layout', BBox: item.bbox }) });
        elemByMcid[mcid] = ref;
        childRefs.push(ref);
        figures++;
      }
    }

    // Every MCID left in the painting must resolve to an element, or a checker reports untagged
    // content. Text the designer never classified becomes a plain paragraph at the end.
    const defaulted: number[] = [];
    for (const runs of sourceNodes) {
      if (usedNodes.has(runs)) continue;
      const ref = emitText(runs, 'P', sectionRef);
      if (!ref) continue;
      defaulted.push(...runs.map((r) => r.mcid));
      childRefs.push(ref);
    }

    if (!childRefs.length) sectionRefs.pop(); // everything on this frame was decorative
    else ctx.assign(
      sectionRef,
      ctx.obj({
        Type: 'StructElem',
        S: 'Sect',
        P: documentElemRef,
        Pg: pageRef,
        T: PDFHexString.fromText(pageInput.name),
        K: childRefs,
      }),
    );

    for (const form of forms) {
      if (!form.elems.length) continue;
      const key = nextKey++;
      form.stream.dict.set(n('StructParents'), PDFNumber.of(key));
      formEntries.push([key, ctx.obj(form.elems) as PDFArray]);
    }

    // ParentTree entry: an array indexed by MCID, so slot i owns MCID i on this page.
    const byMcidArray = ctx.obj(elemByMcid.map((r) => r!)) as PDFArray;
    parentTreeNums.push(PDFNumber.of(structParents));
    parentTreeNums.push(byMcidArray);

    report.pages.push({
      name: pageInput.name,
      structParents,
      mcidCount: elemByMcid.length,
      matched: usedNodes.size,
      unmatched,
      defaulted,
      figures,
      decorative: decorative.size,
      tables,
      lists,
      links,
    });
  }

  // Keys after the pages' come from one counter (links and forms interleave): keep them sorted.
  const later: Array<[number, PDFRef | PDFArray]> = [...annotEntries, ...formEntries].sort((a, b) => a[0] - b[0]);
  for (const [key, ref] of later) { parentTreeNums.push(PDFNumber.of(key)); parentTreeNums.push(ref); }
  const parentTreeRef = ctx.register(ctx.obj({ Type: 'ParentTree', Nums: parentTreeNums }));

  ctx.assign(
    documentElemRef,
    ctx.obj({ Type: 'StructElem', S: 'Document', P: structTreeRootRef, K: sectionRefs }),
  );
  ctx.assign(
    structTreeRootRef,
    ctx.obj({
      Type: 'StructTreeRoot',
      K: [documentElemRef],
      ParentTree: parentTreeRef,
      ParentTreeNextKey: nextKey,
    }),
  );

  report.bookmarks = addBookmarks(doc, headings);
  for (const d of pendingDests) {
    const page = pageRefs[d.pageIndex];
    if (page) d.annot.set(n('Dest'), ctx.obj([page, 'XYZ', null, d.top ?? doc.getPage(d.pageIndex).getHeight(), null] as never));
  }

  doc.catalog.set(n('StructTreeRoot'), structTreeRootRef);
  doc.catalog.set(n('MarkInfo'), ctx.obj({ Marked: true }));
  doc.setLanguage(language);
  doc.setTitle(input.title, { showInWindowTitleBar: true });
  doc.setCreator('figma-a11y-pdf');
  doc.setProducer('figma-a11y-pdf');

  // XMP must stay uncompressed, and PDF/UA wants the pdfuaid:part declaration.
  const metadataRef = ctx.register(
    ctx.stream(xmpPacket(input.title, language), {
      Type: 'Metadata',
      Subtype: 'XML',
    }),
  );
  doc.catalog.set(n('Metadata'), metadataRef);

  // Compression runs last: Figure tags were matched to images by their original pixel size.
  if (options.quality && options.quality !== 'original') {
    if (!options.codec) throw new Error('Image compression needs an image codec.');
    report.images = await compressImages(doc, options.quality, options.codec, (page) => readPageContent(page),
      (done, total) => progress({ phase: 'compress', done, total }));
    // Vector drawing code: numbers rounded to what's visible, recompressed at the highest level.
    report.vectors = slimVectors(doc);
  }

  await progress({ phase: 'save', done: 0, total: 1 });
  const pdf = await doc.save({ useObjectStreams: true });
  return { pdf, report };
}

/**
 * Bookmarks (the PDF outline) from the H1–H3 headings, nested by level, each jumping to its
 * heading. A screen reader user gets the same thing from the heading list; this is for everyone
 * else, and for long documents Acrobat's checker asks for it.
 */
function addBookmarks(doc: PDFDocument, headings: Array<{ level: number; title: string; page: PDFRef; top: number }>): number {
  if (!headings.length) return 0;
  const ctx = doc.context;
  type Node = { ref: PDFRef; dict: PDFDict; level: number; kids: Node[] };
  const root: Node = { ref: ctx.nextRef(), dict: ctx.obj({ Type: 'Outlines' }) as PDFDict, level: 0, kids: [] };
  const stack: Node[] = [root];
  for (const h of headings) {
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
    const parent = stack[stack.length - 1];
    const node: Node = {
      ref: ctx.nextRef(),
      dict: ctx.obj({ Title: PDFHexString.fromText(h.title), Parent: parent.ref, Dest: [h.page, 'XYZ', null, h.top, null] }) as PDFDict,
      level: h.level,
      kids: [],
    };
    parent.kids.push(node);
    stack.push(node);
  }
  const link = (node: Node): number => {
    let count = 0;
    node.kids.forEach((kid, i) => {
      if (i > 0) kid.dict.set(n('Prev'), node.kids[i - 1].ref);
      if (i < node.kids.length - 1) kid.dict.set(n('Next'), node.kids[i + 1].ref);
      count += 1 + link(kid);
    });
    if (node.kids.length) {
      node.dict.set(n('First'), node.kids[0].ref);
      node.dict.set(n('Last'), node.kids[node.kids.length - 1].ref);
      node.dict.set(n('Count'), PDFNumber.of(count)); // every descendant: the items are open
    }
    ctx.assign(node.ref, node.dict);
    return count;
  };
  const total = link(root);
  doc.catalog.set(n('Outlines'), root.ref);
  doc.catalog.set(n('PageMode'), n('UseOutlines'));
  return total;
}
