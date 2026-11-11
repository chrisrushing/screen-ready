/**
 * Figma sandbox side. Reads the frame tree, persists the designer's semantics as plugin data,
 * and exports each frame's native PDF. All PDF work happens in the UI iframe (see ui.ts).
 */
import type { TextRole } from './types.ts';
import type { ColorProfile, DocState, FrameState, ItemState, ToSandbox, ToUI } from './messages.ts';
import type { QualityPreset } from './compress.ts';
import { isRtlText, readingOrder, type OrderNode } from './order.ts';
import { findCharts, placeCharts } from './charts.ts';
import { findOutlinedText, type OutlineNode } from './outlined.ts';
import { findDiagrams } from './diagrams.ts';

const KEY = {
  role: 'a11y.role',
  alt: 'a11y.alt',
  decorative: 'a11y.decorative',
  order: 'a11y.order',
  structuresOff: 'a11y.structuresOff',
  styleRoles: 'a11y.styleRoles',
  lang: 'a11y.lang',
  pages: 'a11y.pages',
  acceptContrast: 'a11y.acceptContrast',
  dismissed: 'a11y.dismissed',
  title: 'a11y.docTitle',
  language: 'a11y.docLang',
  quality: 'a11y.quality',
  colorProfile: 'a11y.colorProfile',
  /** On a diagram's art: its labels, as last approved in its alt text (so they're not drafted in again). */
  labelsChecked: 'a11y.labelsChecked',
};
const ROLES: TextRole[] = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'Artifact'];

figma.showUI(__html__, { width: 400, height: 680, themeColors: true, title: 'Screen Ready' });

const post = (msg: ToUI) => figma.ui.postMessage(msg);

/**
 * Frames to work on: the selected top-level frames, else every top-level frame on the page.
 * Pinned as a working set, so clicking a layer in the UI (which changes the canvas selection)
 * does not silently shrink what gets exported.
 */
let workingIds: string[] = [];
let workingSource: 'selection' | 'page' = 'page';
/** The selection the plugin itself last made, so that change isn't taken for the designer's. */
let ownSelection: Set<string> | null = null;
/** True while the plugin is switching page and selecting for a jump. */
let jumping = false;

/** What counts as a page: a frame, component or instance at the top of the page or of a Section. */
type PageFrame = FrameNode | ComponentNode | InstanceNode;
const isPageFrame = (n: BaseNode): n is PageFrame => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE';
/** On the page itself, or only inside Sections or plain groups (people group whole slides too). */
const isTopLevel = (n: BaseNode) => {
  for (let p = n.parent; p; p = p.parent) {
    if (p.type === 'PAGE') return true;
    if (p.type !== 'SECTION' && p.type !== 'GROUP') return false;
  }
  return false;
};

/** The page-level frame a selected layer belongs to (Sections are looked through). */
function topFrame(n: BaseNode): PageFrame | null {
  let cur: BaseNode | null = n;
  while (cur && !(isPageFrame(cur) && isTopLevel(cur))) cur = cur.parent;
  return cur && isPageFrame(cur) ? cur : null;
}

/** Every visible page-level frame on the current page, including those inside Sections. */
function allFrames(): PageFrame[] {
  return collectFrames(figma.currentPage.children);
}

function retarget(): void {
  const picked = new Map<string, PageFrame>();
  const take = (f: PageFrame) => { if (f.getPluginData('a11y.overlay') !== '1') picked.set(f.id, f); };
  for (const n of figma.currentPage.selection) {
    const f = topFrame(n);
    if (f) take(f);
    // A Section or group of slides: every page in it.
    else if (n.type === 'SECTION' || n.type === 'GROUP') collectFrames(n.children).forEach(take);
  }
  workingSource = picked.size ? 'selection' : 'page';
  applyPages(picked.size ? [...picked.values()] : allFrames());
}

/**
 * Export order: reading position (row by row, left to right), with the designer's page order
 * applied — pages they ordered fill the slots of ordered pages, in their order; pages added since
 * keep their place. Pages they left out aren't exported.
 */
function applyPages(frames: PageFrame[]) {
  const pos = (f: PageFrame) => f.absoluteBoundingBox ?? { x: f.x, y: f.y };
  frames.sort((a, b) => (Math.abs(pos(a).y - pos(b).y) < 1 ? pos(a).x - pos(b).x : pos(a).y - pos(b).y));
  const { order, skip } = pageSettings();
  const rank = new Map(order.map((id, i) => [id, i]));
  const ranked = frames.filter((f) => rank.has(f.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  let next = 0;
  const ordered = frames.map((f) => (rank.has(f.id) ? ranked[next++] : f));
  candidateIds = ordered.map((f) => f.id);
  workingIds = ordered.filter((f) => !skip.includes(f.id)).map((f) => f.id);
}

function collectFrames(nodes: readonly SceneNode[]): PageFrame[] {
  const out: PageFrame[] = [];
  for (const n of nodes) {
    if (!n.visible || n.getPluginData('a11y.overlay') === '1') continue;
    if (isPageFrame(n)) out.push(n);
    else if (n.type === 'SECTION' || n.type === 'GROUP') out.push(...collectFrames(n.children));
  }
  return out;
}

/** Every frame the export could include, in export order (left-out pages too, to bring back). */
let candidateIds: string[] = [];
function pageSettings(): { order: string[]; skip: string[] } {
  const raw = safeJson<{ order?: unknown; skip?: unknown }>(figma.root.getPluginData(KEY.pages), {});
  const ids = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
  return { order: ids(raw.order), skip: ids(raw.skip) };
}

async function workingFrames(): Promise<PageFrame[]> {
  const nodes = await Promise.all(workingIds.map((id) => figma.getNodeByIdAsync(id)));
  return nodes.filter((n): n is PageFrame => !!n && isPageFrame(n));
}

/** Figma leaves hidden layers out of the PDF, so we leave them out too. */
function visibleWithin(node: SceneNode, frame: PageFrame): boolean {
  let cur: BaseNode | null = node;
  while (cur && cur !== frame) {
    if ('visible' in cur && !cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

function pdfBBox(node: SceneNode, frame: PageFrame): [number, number, number, number] {
  const nb = node.absoluteBoundingBox;
  const fb = frame.absoluteBoundingBox;
  if (!nb || !fb) return [0, 0, 0, 0];
  // 1 Figma px = 1 PDF pt (confirmed from the export's MediaBox). PDF's origin is bottom-left.
  const x0 = nb.x - fb.x;
  const yTop = nb.y - fb.y;
  return [x0, fb.height - (yTop + nb.height), x0 + nb.width, fb.height - yTop];
}

const styleNames = new Map<string, string>();
async function styleName(id: string): Promise<string> {
  if (!id) return '';
  if (!styleNames.has(id)) {
    const style = await figma.getStyleByIdAsync(id);
    styleNames.set(id, style ? style.name : '');
  }
  return styleNames.get(id)!;
}

/** Mirrors the layer tree for ordering: hidden layers and branches with nothing to tag drop out. */
function orderTree(node: SceneNode, frame: PageFrame, items: Set<string>): OrderNode | null {
  if (node !== frame && 'visible' in node && !node.visible) return null;
  const children =
    'children' in node && node.type !== 'BOOLEAN_OPERATION'
      ? node.children.map((c) => orderTree(c, frame, items)).filter((c): c is OrderNode => !!c)
      : [];
  const item = items.has(node.id);
  if (!item && !children.length && node !== frame) return null;
  const nb = node.absoluteBoundingBox;
  const fb = frame.absoluteBoundingBox;
  return {
    id: node.id,
    box: nb && fb ? { x: nb.x - fb.x, y: nb.y - fb.y, w: nb.width, h: nb.height } : { x: 0, y: 0, w: 0, h: 0 },
    item,
    flow: 'layoutMode' in node && node.layoutMode !== 'NONE',
    absolute: 'layoutPositioning' in node && node.layoutPositioning === 'ABSOLUTE',
    children,
  };
}

/**
 * Mirrors the layer tree for chart detection: shapes (painted only), text and containers.
 *
 * Huge artwork without text (a map of every country, an imported illustration, a pattern) is one
 * block: its layers say nothing to a screen reader, and walking each of them would only slow the
 * read down. A container with hundreds of children is checked for text natively, and skipped
 * without being walked; one that turns out to hold thousands of shapes is folded after the walk.
 */
const BULK_CHILDREN = 400;
const BULK_LAYERS = 1500;
function chartTree(n: SceneNode, frame: PageFrame, fb: Rect): OutlineNode | null {
  const sizes = new Map<OutlineNode, { layers: number; text: boolean }>();
  const fold = (o: OutlineNode, shapes: number): OutlineNode => ({ ...o, children: [], bulk: shapes });
  const walk = (n: SceneNode): OutlineNode | null => {
    const o = chartNode(n, frame, fb, walk);
    if (!o) return null;
    if (o.kind !== 'container') { sizes.set(o, { layers: 1, text: o.kind === 'text' }); return o; }
    if (o.bulk !== undefined) { sizes.set(o, { layers: 1, text: false }); return o; }
    let layers = 1, text = false;
    for (const c of o.children) { const s = sizes.get(c)!; layers += s.layers; text ||= s.text; }
    if (!text && layers > BULK_LAYERS && n !== frame) { const f = fold(o, layers - 1); sizes.set(f, { layers: 1, text: false }); return f; }
    sizes.set(o, { layers, text });
    return o;
  };
  return walk(n);
}

function chartNode(n: SceneNode, frame: PageFrame, fb: Rect, walk: (c: SceneNode) => OutlineNode | null): OutlineNode | null {
  if (n !== frame && 'visible' in n && !n.visible) return null;
  const nb = n.absoluteBoundingBox;
  if (!nb) return null;
  const box = { x: nb.x - fb.x, y: nb.y - fb.y, w: nb.width, h: nb.height };
  const abs = 'layoutPositioning' in n && n.layoutPositioning === 'ABSOLUTE';
  const up = n.parent;
  const placed = abs || (n !== frame && !!up && !('layoutMode' in up && up.layoutMode !== 'NONE'));
  if (n.type === 'TEXT') return { id: n.id, name: n.name, kind: 'text', box, abs, placed, text: n.characters, children: [] };
  if ('children' in n && n.type !== 'BOOLEAN_OPERATION') {
    if (n !== frame && n.children.length >= BULK_CHILDREN && 'findAllWithCriteria' in n && !n.findAllWithCriteria({ types: ['TEXT'] }).length)
      return { id: n.id, name: n.name, type: n.type, kind: 'container', box, abs, placed, bulk: n.children.length, children: [] };
    const filled = (n.type === 'FRAME' || n.type === 'INSTANCE' || n.type === 'COMPONENT') && n !== frame && Array.isArray(n.fills) &&
      (n.fills as readonly Paint[]).some((p) => p.type === 'SOLID' && p.visible !== false && (p.opacity ?? 1) > 0);
    return { id: n.id, name: n.name, type: n.type, kind: 'container', box, abs, placed, ...(filled ? { filled } : {}), children: n.children.map(walk).filter((c): c is OutlineNode => !!c) };
  }
  const shown = (ps: unknown) => Array.isArray(ps) && (ps as Paint[]).some((p) => p.visible !== false && (p.opacity === undefined || p.opacity > 0));
  const filled = 'fills' in n && shown(n.fills);
  const stroked = 'strokes' in n && shown(n.strokes);
  if (!filled && !stroked) return null; // invisible helper shapes say nothing
  const thin = box.w < 2 || box.h < 2;
  const arc = n.type === 'ELLIPSE' && n.arcData.endingAngle - n.arcData.startingAngle < 2 * Math.PI - 0.01;
  return { id: n.id, name: n.name, type: n.type, kind: 'shape', box, line: n.type === 'LINE' || thin, path: !thin && ((n.type === 'VECTOR' && !filled) || arc), children: [] };
}

const safeJson = <T>(s: string, fallback: T): T => {
  try { return s ? ((JSON.parse(s) as T) ?? fallback) : fallback; } catch { return fallback; }
};

/**
 * The same layer inside the main component, for a layer that's part of an instance (its id is
 * "I<instance>;…;<id in the main component>"), or the main component itself for an instance.
 * Roles and alt text set once on the component apply to every instance that hasn't changed them.
 */
/** Counterparts looked up during one read (each layer can ask up to four times). */
let counterparts = new Map<string, Promise<BaseNode | null>>();
function componentCounterpart(node: SceneNode): Promise<BaseNode | null> {
  let hit = counterparts.get(node.id);
  if (!hit) { hit = lookupCounterpart(node); counterparts.set(node.id, hit); }
  return hit;
}
async function lookupCounterpart(node: SceneNode): Promise<BaseNode | null> {
  try {
    if (node.type === 'INSTANCE' && !node.id.startsWith('I')) return await node.getMainComponentAsync();
    if (!node.id.startsWith('I')) return null;
    return await figma.getNodeByIdAsync(node.id.split(';').pop()!);
  } catch {
    return null;
  }
}

/** Plugin data on the layer, else on its component counterpart. */
async function ownOrInherited(node: SceneNode, key: string): Promise<{ value: string; inherited: boolean }> {
  const own = node.getPluginData(key);
  if (own) return { value: own, inherited: false };
  const cp = await componentCounterpart(node);
  const value = cp && 'getPluginData' in cp ? cp.getPluginData(key) : '';
  return { value, inherited: !!value };
}

/** First visible solid fill of a text layer, as 0–255 RGB and an effective opacity. */
function textColor(t: TextNode): { color?: [number, number, number]; colorAlpha?: number } {
  const fills = t.fills === figma.mixed ? [] : (t.fills as readonly Paint[]);
  const shown = (ps: readonly Paint[]) => ps.some((p) => p.visible !== false && (p.opacity ?? 1) > 0);
  // No fill anyone can see, and no stroke: the words are there but draw nothing.
  if (t.fills !== figma.mixed && !shown(fills) && !shown(t.strokes as readonly Paint[])) return { colorAlpha: 0 };
  const solid = fills.find((p): p is SolidPaint => p.type === 'SOLID' && p.visible !== false);
  if (!solid) return {};
  let alpha = (solid.opacity ?? 1) * t.opacity;
  for (let p = t.parent; p && 'opacity' in p; p = p.parent) alpha *= (p as SceneNode & { opacity: number }).opacity;
  const c = solid.color;
  return { color: [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)], colorAlpha: alpha };
}

/**
 * Cropped out of view: a parent frame with Clip content on doesn't show this layer at all. Its
 * words are in the layers but not on the page, so they aren't read either.
 */
function clippedAway(n: SceneNode, frame: PageFrame): boolean {
  const b = n.absoluteBoundingBox;
  if (!b) return false;
  for (let p = n.parent; p && p !== frame; p = p.parent) {
    if (!('clipsContent' in p) || !p.clipsContent) continue;
    const c = (p as FrameNode).absoluteBoundingBox;
    if (c && (b.x >= c.x + c.width || b.x + b.width <= c.x || b.y >= c.y + c.height || b.y + b.height <= c.y)) return true;
  }
  return false;
}

/**
 * A bullet drawn as a shape (a dot, a dash, a small square) just left of a text layer's first line:
 * the text is a list entry even though no "•" is typed.
 */
function bulletShapes(frame: PageFrame): Array<{ x: number; y: number; w: number; h: number }> {
  const fb = frame.absoluteBoundingBox;
  if (!fb) return [];
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  const shapes = frame.findAllWithCriteria({ types: ['ELLIPSE', 'RECTANGLE', 'VECTOR', 'STAR', 'POLYGON'] });
  if (shapes.length > 3000) return out;
  for (const s of shapes) {
    const b = s.absoluteBoundingBox;
    if (!b || b.width > 14 || b.height > 14 || b.width < 2 || b.height < 2 || !s.visible) continue;
    if (Math.max(b.width, b.height) / Math.min(b.width, b.height) > 3) continue;
    if (!('fills' in s) || !Array.isArray(s.fills) || !(s.fills as readonly Paint[]).some((p) => p.visible !== false)) continue;
    out.push({ x: b.x - fb.x, y: b.y - fb.y, w: b.width, h: b.height });
  }
  return out;
}

function hasBullet(t: TextNode, fb: Rect, bullets: Array<{ x: number; y: number; w: number; h: number }>): boolean {
  const b = t.absoluteBoundingBox;
  if (!b || !bullets.length) return false;
  const x = b.x - fb.x, y = b.y - fb.y;
  const line = (typeof t.fontSize === 'number' ? t.fontSize : 16) * 1.6;
  return bullets.some((s) => s.x + s.w <= x + 1 && x - (s.x + s.w) <= 28 && s.y + s.h / 2 >= y - 2 && s.y + s.h / 2 <= y + line);
}

/** Layer names that mean "this is a logo". "No logo" variants are excluded. */
const LOGO = /(^|[^a-z])(logo|logos|logotype|logomark|wordmark|lockup|brandmark)([^a-z]|$)/i;
const isLogoName = (name: string) => LOGO.test(name) && !/no[\s_-]*logo/i.test(name);

/** The main component's name for an instance, else ''. */
async function componentName(node: SceneNode): Promise<string> {
  if (node.type !== 'INSTANCE') return '';
  const main = await node.getMainComponentAsync();
  if (!main) return '';
  return main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent.name : main.name;
}

/** Does the layer extend past the frame's edges (full-bleed art)? */
function bleeds(node: SceneNode, frame: PageFrame): boolean {
  const nb = node.absoluteBoundingBox, fb = frame.absoluteBoundingBox;
  if (!nb || !fb) return false;
  return nb.x < fb.x - 1 || nb.y < fb.y - 1 || nb.x + nb.width > fb.x + fb.width + 1 || nb.y + nb.height > fb.y + fb.height + 1;
}

function imageFill(node: SceneNode): ImagePaint | null {
  if (!('fills' in node) || !Array.isArray(node.fills)) return null;
  const fill = (node.fills as readonly Paint[]).find(
    (p): p is ImagePaint => p.type === 'IMAGE' && p.visible !== false && !!p.imageHash,
  );
  return fill ?? null;
}

async function readFrame(frame: PageFrame, { thumbnails = true, textOnly = false } = {}): Promise<FrameState> {
  const items: ItemState[] = [];
  const bullets = textOnly ? [] : bulletShapes(frame);
  const fbox = frame.absoluteBoundingBox;

  let layerIndex = -1;
  for (const t of frame.findAllWithCriteria({ types: ['TEXT'] })) {
    layerIndex++;
    if (!visibleWithin(t, frame) || !t.characters.trim()) continue;
    const { value: storedRaw, inherited } = await ownOrInherited(t, KEY.role);
    const stored = storedRaw as TextRole;
    const segs = t.getStyledTextSegments(['fontSize', 'fontWeight', 'textStyleId', 'fontName', 'textCase', 'hyperlink']);
    const links = segs.flatMap((s) => (s.hyperlink && s.hyperlink.type === 'URL' ? [{ text: s.characters, url: s.hyperlink.value, start: s.start, end: s.end }] : []));
    const langOf = await ownOrInherited(t, KEY.lang);
    // The style of the text, taken from its largest run (the one that reads as "the" style).
    const main = segs.reduce((a, b) => (b.fontSize > a.fontSize ? b : a));
    const isSet = ROLES.includes(stored);
    items.push({
      nodeId: t.id,
      kind: 'text',
      name: t.name,
      text: t.characters,
      fontSize: Math.max(...segs.map((s) => s.fontSize)),
      fontWeight: Math.max(...segs.map((s) => s.fontWeight)),
      styleName: await styleName(segs[0].textStyleId),
      fontFamily: main.fontName.family,
      italic: /italic|oblique/i.test(main.fontName.style),
      upper: main.textCase === 'UPPER' || main.textCase === 'SMALL_CAPS_FORCED',
      parentId: t.parent ? t.parent.id : undefined,
      role: isSet ? stored : undefined,
      roleSet: isSet,
      inherited: isSet && inherited,
      ...(links.length ? { links } : {}),
      ...(langOf.value ? { lang: langOf.value, langSet: true } : {}),
      ...textColor(t),
      ...(clippedAway(t, frame) ? { clipped: true } : {}),
      layerIndex,
      ...(fbox && hasBullet(t, fbox, bullets) ? { bulleted: true } : {}),
      bbox: pdfBBox(t, frame),
      group: '',
      autoIndex: 0,
    });
  }

  // Text filled with an image is still text, and is listed once, as text.
  const imageNodes = textOnly ? [] : frame.findAll((n) => n.type !== 'TEXT' && imageFill(n as SceneNode) !== null);
  for (const node of imageNodes) {
    if (!visibleWithin(node, frame)) continue;
    const fill = imageFill(node)!;
    const image = figma.getImageByHash(fill.imageHash!);
    const size = image ? await image.getSizeAsync() : { width: 0, height: 0 };
    let thumb: Uint8Array | undefined;
    if (thumbnails) {
      try {
        thumb = await node.exportAsync({ format: 'PNG', constraint: { type: 'HEIGHT', value: 96 } });
      } catch {
        thumb = undefined; // a preview is nice to have, never worth failing over
      }
    }
    const altOf = await ownOrInherited(node as SceneNode, KEY.alt);
    const decOf = await ownOrInherited(node as SceneNode, KEY.decorative);
    const alt = altOf.value.trim(), dec = decOf.value;
    items.push({
      nodeId: node.id,
      kind: 'image',
      name: node.name,
      alt,
      decorative: dec === '1',
      decided: !!altOf.value || dec === '1' || dec === '0',
      inherited: altOf.inherited || decOf.inherited,
      componentName: await componentName(node as SceneNode),
      signature: 'image:' + fill.imageHash,
      blend: 'blendMode' in node ? node.blendMode : undefined,
      bleeds: bleeds(node as SceneNode, frame),
      thumb,
      naturalWidth: size.width,
      naturalHeight: size.height,
      bbox: pdfBBox(node as SceneNode, frame),
      group: '',
      autoIndex: 0,
    });
  }

  // Vector logos: no image fill, so they'd otherwise be silently decorative. Listed by name (layer
  // or main component), outermost match only, and never a layer that's already an image item.
  const imageIds = new Set(items.filter((i) => i.kind === 'image').map((i) => i.nodeId));
  const logos: SceneNode[] = [];
  const findLogos = async (n: SceneNode) => {
    if (!visibleWithin(n, frame) || n.type === 'TEXT' || imageIds.has(n.id)) return;
    if (isLogoName(n.name) || isLogoName(await componentName(n))) return void logos.push(n);
    if ('children' in n) for (const c of n.children) await findLogos(c);
  };
  if (!textOnly) for (const c of frame.children) await findLogos(c);
  // A logo built around an image fill is one logo, not a logo plus an image.
  for (const logo of logos) {
    if (!('findAll' in logo)) continue;
    const inner = new Set(logo.findAll(() => true).map((n) => n.id));
    for (let k = items.length - 1; k >= 0; k--) if (items[k].kind === 'image' && inner.has(items[k].nodeId)) items.splice(k, 1);
  }
  for (const node of logos) {
    let thumb: Uint8Array | undefined;
    if (thumbnails) {
      try {
        thumb = await node.exportAsync({ format: 'PNG', constraint: { type: 'HEIGHT', value: 96 } });
      } catch {
        thumb = undefined;
      }
    }
    const altOf = await ownOrInherited(node as SceneNode, KEY.alt);
    const decOf = await ownOrInherited(node as SceneNode, KEY.decorative);
    const alt = altOf.value.trim(), dec = decOf.value;
    const comp = await componentName(node);
    items.push({
      nodeId: node.id,
      kind: 'image',
      vector: true,
      name: node.name,
      alt,
      decorative: dec === '1',
      decided: !!altOf.value || dec === '1' || dec === '0',
      inherited: altOf.inherited || decOf.inherited,
      componentName: comp,
      signature: comp ? 'component:' + comp : 'name:' + node.name,
      bleeds: bleeds(node, frame),
      thumb,
      naturalWidth: 0,
      naturalHeight: 0,
      bbox: pdfBBox(node, frame),
      group: '',
      autoIndex: 0,
    });
  }

  // Charts: shapes plus labels, read as one figure with alt text. See charts.ts.
  const fb = frame.absoluteBoundingBox;
  const shapes = !textOnly && fb ? chartTree(frame, frame, fb) : null;
  const charts = shapes ? findCharts(shapes) : [];
  {
    for (const chart of charts) {
      const node = (await figma.getNodeByIdAsync(chart.id)) as SceneNode | null;
      if (!node || items.some((i) => i.nodeId === chart.id)) continue;
      const labels = new Set(chart.labels);
      for (const it of items) if (labels.has(it.nodeId)) it.inChart = chart.id;
      let thumb: Uint8Array | undefined;
      if (thumbnails) {
        try {
          thumb = await node.exportAsync({ format: 'PNG', constraint: { type: 'HEIGHT', value: 96 } });
        } catch {
          thumb = undefined;
        }
      }
      const alt = node.getPluginData(KEY.alt);
      const dec = node.getPluginData(KEY.decorative);
      const { x, y, w, h } = chart.box;
      items.push({
        nodeId: chart.id,
        kind: 'image',
        vector: true,
        chart: true,
        name: node.name,
        alt,
        decorative: dec === '1',
        decided: !!alt || dec === '1' || dec === '0',
        signature: 'chart:' + chart.id,
        thumb,
        naturalWidth: 0,
        naturalHeight: 0,
        bbox: [x, frame.height - (y + h), x + w, frame.height - y],
        group: '',
        autoIndex: 0,
      });
    }
  }

  // Text that isn't text: words outlined into shapes. Each can be a figure whose alt is the words.
  const taken = new Set(items.map((i) => i.nodeId));
  const inside = (box: { x: number; y: number; w: number; h: number }, b: [number, number, number, number]) => {
    const cx = box.x + box.w / 2, cy = frame.height - (box.y + box.h / 2);
    return cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3];
  };
  for (const o of shapes ? findOutlinedText(shapes) : []) {
    if (taken.has(o.id) || items.some((i) => (i.chart || i.vector) && inside(o.box, i.bbox))) continue;
    const node = (await figma.getNodeByIdAsync(o.id)) as SceneNode | null;
    if (!node) continue;
    const altOf = await ownOrInherited(node, KEY.alt);
    const decOf = await ownOrInherited(node, KEY.decorative);
    let thumb: Uint8Array | undefined;
    if (thumbnails) {
      try { thumb = await node.exportAsync({ format: 'PNG', constraint: { type: 'HEIGHT', value: 96 } }); } catch { thumb = undefined; }
    }
    items.push({
      nodeId: o.id, kind: 'image', vector: true, outlined: o.alt ?? '', name: node.name,
      alt: altOf.value.trim(), decorative: decOf.value === '1',
      decided: !!altOf.value || decOf.value === '1' || decOf.value === '0', inherited: altOf.inherited || decOf.inherited,
      signature: 'outlined:' + node.name, suggestion: o.reason, thumb, naturalWidth: 0, naturalHeight: 0,
      bbox: [o.box.x, frame.height - (o.box.y + o.box.h), o.box.x + o.box.w, frame.height - o.box.y], group: '', autoIndex: 0,
    });
  }

  // Diagrams: art with labels laid over it (callouts, floor names, pinned notes), read as one
  // figure whose alt text takes in the labels. See diagrams.ts.
  const byId = new Map(items.map((i) => [i.nodeId, i]));
  const labelSize = Math.max(16, frame.height * 0.025);
  const toBox = (b: [number, number, number, number]) => ({ x: b[0], y: frame.height - b[3], w: b[2] - b[0], h: b[3] - b[1] });
  const diagrams = shapes ? findDiagrams(shapes, {
    anchors: items.filter((i) => i.kind === 'image' && !i.chart && !i.decorative).map((i) => ({ id: i.nodeId, name: i.name, box: toBox(i.bbox) })),
    isLabel: (id) => {
      const it = byId.get(id);
      const text = (it?.text ?? '').replace(/\s+/g, ' ').trim();
      return !!it && it.kind === 'text' && !it.inChart && !!text && text.length <= 60 && text.split(' ').length <= 8 &&
        (it.fontSize ?? 0) <= labelSize && !(it.roleSet && /^H/.test(it.role ?? ''));
    },
    taken: new Set(items.filter((i) => i.kind === 'image').map((i) => i.nodeId)),
  }) : [];
  for (const d of diagrams) {
    let art = byId.get(d.id);
    const node = (await figma.getNodeByIdAsync(d.id)) as SceneNode | null;
    if (!node) continue;
    if (!art) {
      let thumb: Uint8Array | undefined;
      if (thumbnails) {
        try { thumb = await node.exportAsync({ format: 'PNG', constraint: { type: 'HEIGHT', value: 96 } }); } catch { thumb = undefined; }
      }
      const alt = node.getPluginData(KEY.alt), dec = node.getPluginData(KEY.decorative);
      const { x, y, w, h } = d.box;
      art = {
        nodeId: d.id, kind: 'image', vector: true, name: node.name, alt: alt.trim(), decorative: dec === '1',
        decided: !!alt || dec === '1' || dec === '0', signature: 'diagram:' + d.id, thumb, naturalWidth: 0, naturalHeight: 0,
        bbox: [x, frame.height - (y + h), x + w, frame.height - y], group: '', autoIndex: 0,
      };
      items.push(art);
      byId.set(d.id, art);
    }
    art.diagram = true;
    art.labelUnits = d.units;
    art.labelsChecked = node.getPluginData(KEY.labelsChecked);
    for (const id of d.labels) { const l = byId.get(id); if (l) l.inChart = d.id; }
  }

  // Automatic order follows the layer structure: auto-layout flow, then grouping, then position.
  const tree = orderTree(frame, frame, new Set(items.map((i) => i.nodeId)));
  // A page in Arabic or Hebrew reads its columns right to left.
  const rtl = isRtlText(items.filter((i) => i.kind === 'text').map((i) => i.text ?? ''));
  const auto = tree ? placeCharts(readingOrder(tree, { rtl }), (o) => o.id, [...charts, ...diagrams]) : [];
  const autoAt = new Map(auto.map((o, i) => [o.id, i]));
  const groupOf = new Map(auto.map((o) => [o.id, o.group]));
  for (const it of items) {
    it.autoIndex = autoAt.get(it.nodeId) ?? Number.MAX_SAFE_INTEGER;
    it.group = groupOf.get(it.nodeId) ?? it.nodeId;
  }

  // The designer's own order wins. Layers added since then slot in by the automatic order;
  // layers deleted since then just drop out.
  const storedRaw = safeJson<unknown>(frame.getPluginData(KEY.order), []);
  const stored: string[] = Array.isArray(storedRaw) ? storedRaw.filter((x): x is string => typeof x === 'string') : [];
  const rank = new Map(stored.map((id, i) => [id, i]));
  items.sort((a, b) => {
    const ra = rank.get(a.nodeId);
    const rb = rank.get(b.nodeId);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.autoIndex - b.autoIndex;
  });

  const offRaw = safeJson<unknown>(frame.getPluginData(KEY.structuresOff), []);
  const off: string[] = Array.isArray(offRaw) ? offRaw.filter((x): x is string => typeof x === 'string') : [];
  return { id: frame.id, name: frame.name, width: frame.width, height: frame.height, items, orderSet: stored.length > 0, structuresOff: off };
}

/** An empty title means "not set yet" — the UI suggests one from the first H1. */
function readDoc(): DocState {
  const quality = figma.root.getPluginData(KEY.quality) as QualityPreset;
  const profile = figma.root.getPluginData(KEY.colorProfile) as ColorProfile;
  return {
    title: figma.root.getPluginData(KEY.title),
    language: figma.root.getPluginData(KEY.language) || 'en-US',
    quality: ['original', 'print', 'balanced', 'small'].includes(quality) ? quality : 'original',
    colorProfile: ['DOCUMENT', 'SRGB', 'DISPLAY_P3_V4'].includes(profile) ? profile : 'DOCUMENT',
    styleRoles: safeJson(figma.root.getPluginData(KEY.styleRoles), {}),
    acceptContrast: figma.root.getPluginData(KEY.acceptContrast) === '1',
    dismissed: safeJson<string[]>(figma.root.getPluginData(KEY.dismissed), []),
  };
}

/** Each read is numbered; a slower, older read finishing late must not replace a newer one. */
let readSeq = 0;
async function sendState() {
  const seq = ++readSeq;
  counterparts = new Map();
  try {
    const frames = await workingFrames();
    // Headings are suggested from the whole document's type scale, so when only some frames are
    // selected, the rest of the page is read too — text only, no thumbnails — as context.
    const page = allFrames();
    const position = new Map(page.map((f, i) => [f.id, i]));
    const working = new Set(frames.map((f) => f.id));
    const others = page.filter((f) => !working.has(f.id));
    const total = frames.length + others.length;
    // Report each frame as it's read, so the panel shows progress instead of a blank list.
    let done = 0;
    post({ type: 'reading', done, total });
    const read = async (f: PageFrame, textOnly: boolean) => {
      const state = await readFrame(f, { thumbnails: !textOnly, textOnly });
      state.pageIndex = position.get(f.id) ?? -1;
      post({ type: 'reading', done: ++done, total });
      return state;
    };
    const states = await Promise.all(frames.map((f) => read(f, false)));
    const context = await Promise.all(others.map((f) => read(f, true)));
    if (seq !== readSeq) return;
    const skip = new Set(pageSettings().skip);
    const nodes = await Promise.all(candidateIds.map((id) => figma.getNodeByIdAsync(id)));
    const pages = nodes.flatMap((n) => (n ? [{ id: n.id, name: n.name, skip: skip.has(n.id) }] : []));
    post({ type: 'state', frames: states, context, doc: readDoc(), fileName: figma.root.name, source: workingSource, pages });
  } catch (err) {
    if (seq !== readSeq) return;
    post({ type: 'error', message: `Couldn't read the frames: ${err instanceof Error ? err.message : String(err)}` });
  }
}

/**
 * A frame shows the variable modes it inherits (a Section or page set to "Dark"), but a frame
 * exported on its own falls back to the default mode — light text turns dark in the PDF. So for
 * the export, pin the inherited modes on the frame itself, then put things back exactly as they were.
 */
const pins = new Map<string, { count: number; collections: VariableCollection[] }>();
async function withInheritedModes<T>(frame: PageFrame, run: () => Promise<T>): Promise<T> {
  // A render and an export of the same frame can overlap: the first one in pins, the last one out
  // puts things back.
  let pin = pins.get(frame.id);
  if (pin) pin.count++;
  else {
    pin = { count: 1, collections: [] };
    pins.set(frame.id, pin);
    try {
      const explicit = frame.explicitVariableModes ?? {};
      for (const [collectionId, modeId] of Object.entries(frame.resolvedVariableModes ?? {})) {
        if (explicit[collectionId]) continue; // the frame already says which mode it wants
        const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
        if (!collection || modeId === collection.defaultModeId) continue; // the default is what export uses anyway
        frame.setExplicitVariableModeForCollection(collection, modeId);
        pin.collections.push(collection);
      }
    } catch {
      // Can't pin (a library collection, a locked node): export as Figma would have.
    }
  }
  try {
    return await run();
  } finally {
    if (--pin.count === 0) {
      pins.delete(frame.id);
      for (const collection of pin.collections) {
        try { frame.clearExplicitVariableModeForCollection(collection); } catch { /* already gone */ }
      }
    }
  }
}

async function exportAll() {
  const frames = await workingFrames();
  if (!frames.length) throw new Error('No frames to export. Select one or more frames on the canvas.');
  const pages: Array<{ frame: FrameState; pdf: Uint8Array }> = [];
  for (let i = 0; i < frames.length; i++) {
    post({ type: 'progress', done: i, total: frames.length });
    const pdf = await withInheritedModes(frames[i], () => frames[i].exportAsync({ format: 'PDF', colorProfile: readDoc().colorProfile }));
    pages.push({ frame: await readFrame(frames[i], { thumbnails: false }), pdf });
  }
  post({ type: 'progress', done: frames.length, total: frames.length });
  post({ type: 'exported', doc: readDoc(), pages });
}

// =============================================================================================
// Reading order on the canvas: numbered badges joined by a line, over each frame. They live in
// their own top-level frames (never inside the designer's frames, so exports never include them),
// are locked, and are removed when the toggle goes off or the plugin closes.
// =============================================================================================

const OVERLAY = 'a11y.overlay';
const BADGE_COLOR: Record<string, RGB> = {
  heading: { r: 0.05, g: 0.36, b: 0.85 },
  text: { r: 0.2, g: 0.2, b: 0.22 },
  figure: { r: 0.0, g: 0.5, b: 0.33 },
  table: { r: 0.55, g: 0.24, b: 0.78 },
  list: { r: 0.55, g: 0.24, b: 0.78 },
};

function clearOrderOverlay() {
  for (const page of figma.root.children) {
    // Only pages already loaded can hold an overlay we drew.
    const visit = (nodes: readonly SceneNode[]) => {
      for (const n of nodes) {
        if (n.getPluginData(OVERLAY) === '1') n.remove();
        else if (n.type === 'SECTION') visit(n.children);
      }
    };
    try { visit(page.children); } catch { /* page not loaded */ }
  }
}

/** Draws are numbered: a newer draw (or a hide) makes an older one stop and clean up after itself. */
let overlayGen = 0;
async function showOrderOverlay(frames: Extract<ToSandbox, { type: 'show-order' }>['frames']) {
  const gen = ++overlayGen;
  clearOrderOverlay();
  if (!frames.length) return;
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  for (const { frameId, steps } of frames) {
    if (gen !== overlayGen) return;
    const frame = await figma.getNodeByIdAsync(frameId);
    if (gen !== overlayGen) return;
    if (!frame || !('absoluteBoundingBox' in frame) || !frame.absoluteBoundingBox) continue;
    let page: BaseNode | null = frame;
    while (page && page.type !== 'PAGE') page = page.parent;
    if (!page) continue;
    const fb = frame.absoluteBoundingBox;
    // Where each step's layers are, looked up together (not one await per layer).
    const boxesOf = await Promise.all(steps.map(async (step) => {
      const nodes = await Promise.all(step.ids.map((id) => figma.getNodeByIdAsync(id)));
      return nodes.flatMap((n) => (n && 'absoluteBoundingBox' in n && n.absoluteBoundingBox ? [n.absoluteBoundingBox] : []));
    }));
    if (gen !== overlayGen) return;

    // Everything is created inside the overlay frame and marked, so a failure or a newer draw
    // can't leave loose layers behind in the file.
    const overlay = figma.createFrame();
    overlay.setPluginData(OVERLAY, '1');
    try {
      overlay.name = `Reading order · ${frame.name} (temporary)`;
      overlay.fills = [];
      overlay.clipsContent = false;
      overlay.resize(Math.max(1, fb.width), Math.max(1, fb.height));
      (page as PageNode).appendChild(overlay);
      overlay.x = fb.x;
      overlay.y = fb.y;
      const size = Math.max(16, Math.round(fb.width / 56));
      const points: Array<[number, number]> = [];
      let n = 0;
      steps.forEach((step, k) => {
        const boxes = boxesOf[k];
        if (!boxes.length) return;
        n++;
        const x0 = Math.min(...boxes.map((b) => b.x)) - fb.x;
        const y0 = Math.min(...boxes.map((b) => b.y)) - fb.y;
        const x1 = Math.max(...boxes.map((b) => b.x + b.width)) - fb.x;
        const y1 = Math.max(...boxes.map((b) => b.y + b.height)) - fb.y;
        const color = BADGE_COLOR[step.kind] ?? BADGE_COLOR.text;

        // A faint outline of what this number stands for.
        const outline = figma.createRectangle();
        overlay.appendChild(outline);
        outline.resize(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        outline.x = x0;
        outline.y = y0;
        outline.fills = [];
        outline.strokes = [{ type: 'SOLID', color, opacity: 0.55 }];
        outline.strokeWeight = Math.max(1, size / 14);
        outline.dashPattern = [size / 4, size / 6];
        outline.cornerRadius = 2;

        const badge = figma.createFrame();
        overlay.appendChild(badge);
        badge.name = `${n}`;
        badge.resize(size + (n >= 10 ? size * 0.35 : 0), size);
        badge.cornerRadius = size / 2;
        badge.fills = [{ type: 'SOLID', color }];
        badge.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        badge.strokeWeight = Math.max(1.5, size / 12);
        badge.layoutMode = 'HORIZONTAL';
        badge.primaryAxisAlignItems = 'CENTER';
        badge.counterAxisAlignItems = 'CENTER';
        badge.primaryAxisSizingMode = 'FIXED';
        badge.counterAxisSizingMode = 'FIXED';
        const label = figma.createText();
        badge.appendChild(label);
        label.fontName = { family: 'Inter', style: 'Bold' };
        label.fontSize = Math.round(size * 0.5);
        label.characters = String(n);
        label.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        badge.x = x0 - size / 2;
        badge.y = y0 - size / 2;
        points.push([x0, y0]);
      });

      // The path a screen reader takes, badge to badge, under the badges.
      if (points.length > 1) {
        const path = figma.createVector();
        overlay.insertChild(0, path);
        // Path coordinates are relative to the vector itself, which sits at the top-left point.
        const minX = Math.min(...points.map((p) => p[0])), minY = Math.min(...points.map((p) => p[1]));
        path.vectorPaths = [{ windingRule: 'NONE', data: points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x - minX} ${y - minY}`).join(' ') }];
        path.x = minX;
        path.y = minY;
        path.strokes = [{ type: 'SOLID', color: { r: 0.95, g: 0.2, b: 0.45 }, opacity: 0.7 }];
        path.strokeWeight = Math.max(1.5, size / 10);
        path.fills = [];
      }
      overlay.locked = true;
    } catch (err) {
      overlay.remove();
      throw err;
    }
    // Superseded while drawing: this overlay is out of date, and the newer draw has already cleared.
    if (gen !== overlayGen) { overlay.remove(); return; }
  }
}

figma.on('close', clearOrderOverlay);

/**
 * Messages that read or change the file run one at a time, in order: an alt text typed just
 * before Export is saved before the export reads it. Selecting, the order overlay, opening a link
 * and the intro don't wait behind a long export.
 */
let queue: Promise<void> = Promise.resolve();
const IMMEDIATE = new Set<ToSandbox['type']>(['select', 'show-order', 'open-url', 'set-auto-read', 'show-start']);
figma.ui.onmessage = (msg: ToSandbox) => {
  if (IMMEDIATE.has(msg.type)) return void handle(msg);
  queue = queue.then(() => handle(msg));
};

async function handle(msg: ToSandbox): Promise<void> {
  try {
    switch (msg.type) {
      case 'refresh':
        started = true;
        if (!msg.keep) retarget();
        return sendState();
      case 'set-role': {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        // An empty role clears the designer's choice, so the suggestion applies again.
        if (node && node.type === 'TEXT') node.setPluginData(KEY.role, ROLES.includes(msg.role) ? msg.role : '');
        return;
      }
      case 'set-alt': {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        // An empty alt set on purpose is stored as one space, so a component's alt doesn't come back.
        if (node) node.setPluginData(KEY.alt, msg.cleared ? ' ' : msg.alt.trim());
        return;
      }
      case 'set-labels-checked': {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        if (node) node.setPluginData(KEY.labelsChecked, msg.labels);
        return;
      }
      case 'set-decorative': {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        // '1' or '0' — either way the designer has decided, so suggestions stop applying.
        // null clears the choice, so the suggestion applies again.
        if (node) node.setPluginData(KEY.decorative, msg.decorative === null ? '' : msg.decorative ? '1' : '0');
        return;
      }
      case 'set-order': {
        const node = await figma.getNodeByIdAsync(msg.frameId);
        // An empty order clears the designer's order, so the automatic one applies again.
        if (node) node.setPluginData(KEY.order, msg.order.length ? JSON.stringify(msg.order) : '');
        return;
      }
      case 'show-order':
        return showOrderOverlay(msg.frames);
      case 'render': {
        // A flat picture of the frame, for the contrast check in the UI.
        // Always answers, with no picture when the frame is gone or can't be rendered.
        let png: Uint8Array | null = null;
        try {
          const node = await figma.getNodeByIdAsync(msg.frameId);
          if (node && isPageFrame(node)) png = await withInheritedModes(node, () => node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } }));
          else if (node && 'exportAsync' in node) png = await (node as SceneNode).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
        } catch {
          png = null;
        }
        return post({ type: 'rendered', frameId: msg.frameId, png });
      }
      case 'set-lang': {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        if (node && node.type === 'TEXT') node.setPluginData(KEY.lang, msg.lang.trim());
        return;
      }
      case 'set-pages': {
        const ids = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
        figma.root.setPluginData(KEY.pages, JSON.stringify({ order: ids(msg.order), skip: ids(msg.skip) }));
        // Same frames as before (a selection stays a selection); only order and left-out change.
        const nodes = await Promise.all(candidateIds.map((id) => figma.getNodeByIdAsync(id)));
        applyPages(nodes.filter((n): n is PageFrame => !!n && isPageFrame(n)));
        return sendState();
      }
      case 'link-citation': {
        // Fonts in the range must be loaded before the text can be changed.
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        if (!node || node.type !== 'TEXT') return;
        // The text may have changed since it was read: only link the marker if it's still there.
        if (msg.start < 0 || msg.end > node.characters.length || msg.start >= msg.end || node.characters.slice(msg.start, msg.end) !== msg.marker) return;
        const fonts = node.getRangeAllFontNames(msg.start, msg.end);
        await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
        node.setRangeHyperlink(msg.start, msg.end, { type: 'URL', value: msg.url });
        return; // the panel already shows it linked; no re-read, so review progress is kept
      }
      case 'open-url':
        if (msg.url === 'https://specterops.io') figma.openExternal(msg.url);
        return;
      case 'set-auto-read':
        autoRead = msg.on;
        await figma.clientStorage.setAsync(AUTO_READ, msg.on);
        return;
      case 'show-start':
        started = false;
        return postReady();
      case 'set-structures-off': {
        const node = await figma.getNodeByIdAsync(msg.frameId);
        if (node) node.setPluginData(KEY.structuresOff, msg.ids.length ? JSON.stringify(msg.ids) : '');
        return;
      }
      case 'set-doc':
        figma.root.setPluginData(KEY.title, msg.doc.title);
        figma.root.setPluginData(KEY.language, msg.doc.language);
        figma.root.setPluginData(KEY.quality, msg.doc.quality);
        figma.root.setPluginData(KEY.colorProfile, msg.doc.colorProfile);
        figma.root.setPluginData(KEY.styleRoles, JSON.stringify(msg.doc.styleRoles ?? {}));
        figma.root.setPluginData(KEY.acceptContrast, msg.doc.acceptContrast ? '1' : '');
        figma.root.setPluginData(KEY.dismissed, JSON.stringify(msg.doc.dismissed ?? []));
        return;
      case 'select': {
        const nodes: SceneNode[] = [];
        for (const id of msg.nodeIds) {
          const node = await figma.getNodeByIdAsync(id);
          if (node && 'visible' in node) nodes.push(node as SceneNode);
        }
        if (!nodes.length) return;
        await jumpTo(nodes, msg.exact);
        return;
      }
      case 'export':
        return exportAll();
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Shows layers in context: switches to their page if needed, fits their frame (the slide or
 * artboard they're on) in view, and selects them inside it. If that frame is already on screen at
 * a useful size, the view only pans, so you don't lose your place.
 */
async function jumpTo(nodes: SceneNode[], exact = false) {
  let page: BaseNode | null = nodes[0];
  while (page && page.type !== 'PAGE') page = page.parent;
  jumping = true;
  try {
    if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page as PageNode);
    ownSelection = new Set(nodes.map((n) => n.id));
    figma.currentPage.selection = nodes;
  } finally {
    jumping = false;
  }

  if (exact) return zoomToObject(nodes);
  const frame = topFrame(nodes[0]);
  const target = frame ?? nodes[0];
  const b = target.absoluteBoundingBox;
  if (!b) return figma.viewport.scrollAndZoomIntoView(nodes);
  const view = figma.viewport.bounds;
  const inView = b.x >= view.x && b.y >= view.y && b.x + b.width <= view.x + view.width && b.y + b.height <= view.y + view.height;
  const bigEnough = b.width >= view.width * 0.5 || b.height >= view.height * 0.5;
  if (!inView || !bigEnough) figma.viewport.scrollAndZoomIntoView([target]);
}

/**
 * Reviewing one thing: zoom so that thing is clearly visible — about a third of the view, with
 * its surroundings for context — and centered. Never closer than 200%.
 */
function zoomToObject(nodes: SceneNode[]) {
  const boxes = nodes.map((n) => n.absoluteBoundingBox).filter((b): b is Rect => !!b);
  if (!boxes.length) return figma.viewport.scrollAndZoomIntoView(nodes);
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
  const view = figma.viewport.bounds;
  const zoom = figma.viewport.zoom;
  const screenW = view.width * zoom, screenH = view.height * zoom; // the visible canvas, in pixels
  const fit = Math.min((screenW * 0.35) / Math.max(1, x1 - x0), (screenH * 0.35) / Math.max(1, y1 - y0));
  figma.viewport.zoom = Math.min(2, fit);
  figma.viewport.center = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

figma.on('selectionchange', () => {
  // The plugin's own selection (jumping to a row) must not change what gets exported.
  if (jumping) return;
  if (!started) return postReady();
  const ids = figma.currentPage.selection.map((n) => n.id);
  const own = ownSelection;
  if (own && ids.length === own.size && ids.every((id) => own.has(id))) return;
  ownSelection = null;
  // Which frames are being worked on stays as it is ("Use selection" changes it). A click on the
  // canvas only tells the panel where you are, so it can show that page and that layer.
  const selection = figma.currentPage.selection;
  const frame = selection.length ? topFrame(selection[0]) : null;
  post({ type: 'canvas-selection', frameId: frame ? frame.id : null, nodeIds: selection.map((n) => n.id) });
});

// Another page tab: work on that page's frames.
figma.on('currentpagechange', () => {
  if (jumping) return; // the plugin switched page itself, to show a layer
  if (!started) return postReady();
  retarget();
  queue = queue.then(() => sendState());
});

/**
 * Nothing is read until the designer says Start (the start screen asks them to tidy the page
 * first), unless they've chosen to read as soon as the panel opens.
 */
const AUTO_READ = 'a11y.autoRead';
let started = false;
let autoRead = false;
function postReady() {
  retarget();
  post({ type: 'ready', pageName: figma.currentPage.name, frames: candidateIds.length, selected: workingSource === 'selection' ? workingIds.length : 0, autoRead });
}
(async () => {
  autoRead = (await figma.clientStorage.getAsync(AUTO_READ)) === true;
  postReady();
  if (autoRead) { started = true; queue = queue.then(() => sendState()); }
})();
