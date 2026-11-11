/**
 * Turns a frame as the panel shows it (layers with roles, alt text, detected tables and lists) into
 * the items the tagger builds from, in reading order.
 *
 * A table or list is placed where its first layer falls in the reading order, and takes all of its
 * layers with it — so they are read once, as a table or list, not again as loose text.
 */
import type { FrameState, ItemState } from './messages.ts';
import type { ListSuggestion, TableSuggestion } from './structures.ts';
import type { SemanticItem, TextItem } from './types.ts';

const clean = (s = '') => s.replace(/\s+/g, ' ').trim();

/** An image or chart that will be tagged: not decorative, and described. */
export const isFigure = (it: ItemState) => it.kind === 'image' && !it.decorative && !!clean(it.alt);

/** Layer id → "table" or "list", for every layer a detected table or list takes. */
export function structureMembers(tables: TableSuggestion[], lists: ListSuggestion[]): Map<string, 'table' | 'list'> {
  const out = new Map<string, 'table' | 'list'>();
  for (const t of tables) for (const id of [...(t.caption ? [t.caption] : []), ...t.rows.flat(2)]) out.set(id, 'table');
  for (const l of lists) for (const e of l.items) for (const id of [...(e.label ? [e.label] : []), ...e.body]) out.set(id, 'list');
  return out;
}

export function toItems(frame: FrameState, tables: TableSuggestion[] = [], lists: ListSuggestion[] = []): SemanticItem[] {
  const byId = new Map(frame.items.map((i) => [i.nodeId, i]));
  // A chart's or diagram's labels are skipped only when the art itself is read (has alt text);
  // otherwise they are all a screen reader gets, so they stay text.
  const described = new Set(frame.items.filter((i) => (i.chart || i.diagram) && isFigure(i)).map((i) => i.nodeId));
  const roleOf = (it: ItemState) =>
    it.inChart && !it.roleSet ? (described.has(it.inChart) ? 'Artifact' : it.role === 'Artifact' ? 'P' : it.role ?? 'P') : it.role ?? 'P';
  // Layers read as part of another (see joins.ts): carried by the first piece, not read on their own.
  const piecesOf = new Map<string, ItemState[]>();
  for (const it of frame.items) if (it.joinedTo) piecesOf.set(it.joinedTo, [...(piecesOf.get(it.joinedTo) ?? []), it]);
  const text = (it: ItemState): TextItem => {
    const pieces = piecesOf.get(it.nodeId);
    return {
      kind: 'text', nodeId: it.nodeId, text: it.text ?? '', role: roleOf(it), bbox: it.bbox,
      ...(it.lang && it.lang !== '-' ? { lang: it.lang } : {}),
      ...(it.spoken ? { spoken: it.spoken } : {}),
      ...(it.layerIndex !== undefined ? { layerIndex: it.layerIndex } : {}),
      ...(pieces ? { joined: pieces.map((p) => ({ item: { kind: 'text' as const, nodeId: p.nodeId, text: p.text ?? '', role: roleOf(it), bbox: p.bbox }, sep: p.joinSep ?? ' ' })) } : {}),
    };
  };
  const textOf = (id: string) => {
    const it = byId.get(id);
    return it && it.kind === 'text' ? text(it) : null;
  };
  const ids = (xs: Array<TextItem | null>) => xs.filter((x): x is TextItem => !!x);

  // Each structure, keyed by its first layer in reading order.
  const at = new Map<string, SemanticItem>();
  const claimed = new Set<string>();
  const order = new Map(frame.items.map((i, k) => [i.nodeId, k]));
  const first = (members: string[]) => members.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))[0];
  for (const t of tables) {
    const members = [...(t.caption ? [t.caption] : []), ...t.rows.flat(2)].filter((id) => byId.has(id));
    if (!members.length) continue;
    const caption = t.caption ? textOf(t.caption) : null;
    at.set(first([...members]), {
      kind: 'table', nodeId: t.id, headerRow: t.headerRow, ...(t.headerRows ? { headerRows: t.headerRows } : {}), headerCol: t.headerCol, ...(caption ? { caption } : {}),
      rows: t.rows.map((r) => r.map((cell) => ids(cell.map(textOf)))),
    });
    for (const id of members) claimed.add(id);
  }
  for (const l of lists) {
    const members = l.items.flatMap((e) => [...(e.label ? [e.label] : []), ...e.body]).filter((id) => byId.has(id));
    if (!members.length) continue;
    at.set(first([...members]), {
      kind: 'list', nodeId: l.id,
      items: l.items.map((e) => ({ label: e.label ? textOf(e.label) ?? undefined : undefined, body: ids(e.body.map(textOf)) })),
    });
    for (const id of members) claimed.add(id);
  }

  const out: SemanticItem[] = [];
  for (const it of frame.items) {
    const structure = at.get(it.nodeId);
    if (structure) out.push(structure);
    if (claimed.has(it.nodeId)) continue;
    if (it.kind === 'text' && it.joinedTo && byId.has(it.joinedTo)) continue;
    if (it.kind === 'text') out.push(text(it));
    else if (isFigure(it))
      out.push({
        kind: 'image', nodeId: it.nodeId, alt: clean(it.alt),
        naturalWidth: it.naturalWidth ?? 0, naturalHeight: it.naturalHeight ?? 0, bbox: it.bbox, vector: it.vector, chart: it.chart, diagram: it.diagram,
        ...(it.chart || it.diagram ? { labels: frame.items.filter((l) => l.inChart === it.nodeId).map((l) => l.nodeId) } : {}),
      });
    // Decorative images, and undecided ones, stay inside Figma's artifact.
  }
  return out;
}
