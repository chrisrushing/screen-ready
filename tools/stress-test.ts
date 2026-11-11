/**
 * A stress-test page in Figma: eleven
 * frames of deliberately awkward layers, read the way the plugin reads them (tools/stress-frames.json
 * holds the layers as the sandbox sees them). Runs order, role suggestions, joins, tables and lists,
 * then prints what a screen reader would say and checks the cases. Run: node tools/stress-test.ts [-v]
 */
import { readFile } from 'node:fs/promises';
import { isRtlText, readingOrder, type OrderNode } from '../src/order.ts';
import { nestChartTitles, shiftToH1, suggestRoles } from '../src/suggest.ts';
import { findCharts, placeCharts } from '../src/charts.ts';
import { draftChartAlt } from '../src/chartdata.ts';
import type { OutlineNode } from '../src/outlined.ts';
import { suggestStructures } from '../src/structures.ts';
import { structureMembers, toItems } from '../src/items.ts';
import { findJoins, PLACEHOLDER_TEXT, repeatedParagraphs, spacedLetters } from '../src/joins.ts';
import { transcript, spoken } from '../src/preview.ts';
import type { FrameState, ItemState } from '../src/messages.ts';

type Raw = FrameState & { tree: OrderNode };
const raw: Raw[] = JSON.parse(await readFile(new URL('./stress-frames.json', import.meta.url), 'utf8'));
const outlines: Record<string, OutlineNode> = JSON.parse(await readFile(new URL('./stress-outlines.json', import.meta.url), 'utf8'));
const verbose = process.argv.includes('-v');

// As the sandbox does: items in the automatic reading order.
const frames: FrameState[] = raw.map((f) => {
  // Charts, as the sandbox finds them: a figure item for each, its labels marked, read before them.
  const charts = outlines[f.id] ? findCharts(outlines[f.id]) : [];
  const chartItems: ItemState[] = charts.map((c) => ({ nodeId: c.id, kind: 'image', name: c.name, chart: true, alt: '', decided: false,
    bbox: [c.box.x, f.height - (c.box.y + c.box.h), c.box.x + c.box.w, f.height - c.box.y], group: '', autoIndex: 0 }));
  const labels = new Map(charts.flatMap((c) => c.labels.map((l) => [l, c.id] as const)));
  f.items = [...f.items.map((i) => (labels.has(i.nodeId) ? { ...i, inChart: labels.get(i.nodeId) } : i)), ...chartItems];
  const mark = (n: OrderNode): OrderNode => ({ ...n, item: n.item || charts.some((c) => c.id === n.id), children: n.children.map(mark) });
  const order = placeCharts(readingOrder(mark(f.tree), { rtl: isRtlText(f.items.map((i) => i.text ?? '')) }), (o) => o.id, charts);
  const at = new Map(order.map((o, k) => [o.id, k]));
  const group = new Map(order.map((o) => [o.id, o.group]));
  const items = [...f.items].map((i) => ({ ...i, autoIndex: at.get(i.nodeId) ?? 1e9, group: group.get(i.nodeId) ?? i.nodeId }))
    .sort((a, b) => a.autoIndex - b.autoIndex);
  return { id: f.id, name: f.name, width: f.width, height: f.height, items, orderSet: false };
});
// As the panel does: roles, spoken words, tables and lists, joins.
const roles = suggestRoles(frames);
shiftToH1(frames, roles);
for (const f of frames) for (const it of f.items) {
  it.role = roles.get(it.nodeId)?.role ?? 'P';
  it.reason = roles.get(it.nodeId)?.reason;
  it.spoken = spacedLetters(it.text ?? '') ?? undefined;
}
nestChartTitles(frames);
for (const f of frames) for (const it of f.items) if (it.chart) it.alt = draftChartAlt(f.items.filter((l) => l.inChart === it.nodeId), it.bbox).alt;
const { tables, lists } = suggestStructures(frames, (i) => i.role);
const members = structureMembers(tables, lists);
for (const f of frames) {
  const byId = new Map(f.items.map((i) => [i.nodeId, i]));
  for (const j of findJoins(f.items, (i) => i.role, new Set(members.keys()))) {
    const head = byId.get(j.head)!;
    const role = byId.get(j.lead)!.role;
    head.role = role;
    for (const p of j.pieces) { const it = byId.get(p.id)!; it.joinedTo = j.head; it.joinSep = p.sep; it.role = role; }
  }
}

const said = new Map<string, string[]>();
for (const f of frames) {
  const items = toItems(f, tables.filter((t) => t.frameId === f.id), lists.filter((l) => l.frameId === f.id));
  const lines = transcript({ name: f.name, frameId: f.id, items }).map(spoken);
  said.set(f.name.slice(0, 2), lines);
  if (verbose) console.log(`\n${f.name}\n  ${lines.join('\n  ')}`);
}

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };
const page = (n: string) => said.get(n) ?? [];
const has = (n: string, s: string) => page(n).some((l) => l.includes(s));
const item = (n: string, text: string): ItemState => frames.find((f) => f.name.startsWith(n))!.items.find((i) => i.text === text)!;

check('01: the two-line headline is one heading, and the export starts at H1', page('01')[0] === 'Heading level 1, Every page reads in order' && !page('01').some((l) => l.startsWith('Heading') && l.endsWith('reads in order') && !l.includes('Every page')), page('01')[0]);
check('01: the drop cap reads with its paragraph', has('01', 'The report combines survey answers'));
check('01: "$" "120" "K" reads as $120K, "40" "%" as 40%', has('01', '$120K') && page('01').some((l) => /(^|, )40%$/.test(l) || l === '40%'), page('01').filter((l) => /\d/.test(l)).join(' | '));
check('02: invisible, unfilled and cropped text isn’t read', !['Ghost text', 'no fill', 'Cropped out'].some((s) => has('02', s)));
check('02: the DRAFT watermark isn’t read', !has('02', 'DRAFT'), page('02').join(' | '));
check('03: letters typed apart read as words', has('03', 'SCREEN READY'));
check('03: placeholder text is caught for review', PLACEHOLDER_TEXT.test(item('03', 'Headline goes here').text!) && PLACEHOLDER_TEXT.test(item('03', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.').text!));
check('03: an icon-font glyph isn’t read as “check_circle”', !has('03', 'check_circle'));
check('04: bullets drawn as shapes make a list', page('04').some((l) => l.startsWith('List, 3 items')), page('04').join(' | '));
check('04: the footnote marker stays with its sentence', page('04').findIndex((l) => l.includes('five-year low')) === page('04').findIndex((l) => l === '2') - 1);
check('05: the loose card title is read before its chart', page('05').findIndex((l) => l.includes('2026 adoption rate')) < page('05').findIndex((l) => l.startsWith('Image, Chart')), page('05').slice(0, 4).join(' | '));
check('05: the bars and their stray label are one chart', page('05').some((l) => l.startsWith('Image, Chart') && l.includes('None 43%')) && !page('05').includes('None'));
check('05: the loose card source is read after its chart', page('05').findIndex((l) => l.includes('Source: internal client data')) > page('05').findIndex((l) => l.startsWith('Image, Chart')));
check('06/07: footers that swap sides are skipped on both pages', !has('06', 'Screen Ready stress test') && !has('07', 'Screen Ready stress test') && !has('06', '06') && !has('07', '07'),
  [...page('06'), ...page('07')].filter((l) => /stress|^0\d$/.test(l)).join(' | '));
check('08: a right-to-left page reads its right column first', page('08').findIndex((l) => l.includes('العمود الأول')) < page('08').findIndex((l) => l.includes('العمود الثاني')), page('08').map((l) => l.slice(0, 24)).join(' | '));
check('10: bars built from frames are one chart, not loose labels', has('10', 'Image, ') && !page('10').some((l) => l === '-9 pp' || l === 'Beginner'), page('10').join(' | '));
check('10: a column chart with values inside its bars is one chart', page('10').filter((l) => l.startsWith('Image, ')).length === 2 && !page('10').includes('407K'), page('10').filter((l) => l.startsWith('Image')).join(' | '));
check('11: a chart’s title sits one level under its section', page('11').some((l) => /^Heading level 3, Ranking of Top Regions/.test(l)) && page('11').some((l) => /^Heading level [12], Top Roles/.test(l)), page('11').filter((l) => l.startsWith('Heading')).join(' | '));
{
  const f11 = frames.find((f) => f.name.startsWith('11'))!;
  const twice = repeatedParagraphs(f11.items, (i) => i.role === 'Artifact');
  check('11: a paragraph repeated on the page is caught (the later copy)', twice.length === 1 && twice[0].name === 'Paragraph (copy)', twice.map((i) => i.name).join());
}
check('09: the table is found with its header rows', page('09').some((l) => l.startsWith('Table')), page('09').slice(0, 4).join(' | '));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
