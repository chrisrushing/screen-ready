/**
 * Figma edge cases that read wrong unless handled: text split across layers (a heading per line,
 * a drop cap, a number in pieces), letters typed apart, placeholder text, invisible or cropped
 * text, footers that swap sides, bullets drawn as shapes. Run: node tools/edge-cases-test.ts
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
// The PDF/UA check needs veraPDF in tools/vendor (not in the repository); skipped without it.
const VERA = existsSync('tools/vendor/verapdf/verapdf');
import { findJoins, PLACEHOLDER_TEXT, spacedLetters } from '../src/joins.ts';
import { suggestRoles } from '../src/suggest.ts';
import { suggestStructures } from '../src/structures.ts';
import { buildTaggedPdf, readActualTexts } from '../src/tagger.ts';
import type { FrameState, ItemState } from '../src/messages.ts';
import type { SemanticItem, TextItem } from '../src/types.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };

const H = 1080;
let k = 0;
/** x, y from the top-left like Figma; stored as PDF points like the plugin. */
const t = (text: string, fontSize: number, x: number, y: number, w: number, h: number, extra: Partial<ItemState> = {}): ItemState =>
  ({ nodeId: `n${k++}`, kind: 'text', name: text.slice(0, 20), text, fontSize, fontWeight: 400, fontFamily: 'Inter', bbox: [x, H - (y + h), x + w, H - y], group: '', autoIndex: 0, ...extra });
const frame = (name: string, items: ItemState[]): FrameState => ({ id: name, name, width: 1920, height: H, items, orderSet: false });
const role = (i: ItemState) => i.role ?? (i.fontSize! >= 40 ? 'H1' : 'P');

// ---- Split across layers ----
const l1 = t('Every page', 96, 48, 96, 700, 110);
const l2 = t('reads in order', 96, 48, 200, 820, 110);
const body = t('Real-world data shows how quickly the problem grows.', 21, 48, 360, 860, 60);
const split = findJoins([l1, l2, body], role);
check('a heading set one layer per line is one heading', split.length === 1 && split[0].kind === 'heading' && split[0].head === l1.nodeId && split[0].pieces[0].id === l2.nodeId && split[0].pieces[0].sep === ' ', JSON.stringify(split));
const h1 = t('Age', 40, 48, 96, 200, 48), h2 = t('Gender', 40, 48, 560, 200, 48);
check('two headings far apart stay two', findJoins([h1, h2], role).length === 0);
const done = t('Key findings.', 96, 48, 96, 700, 110), next = t('What changed', 96, 48, 200, 700, 110);
check('a heading that ends a sentence isn’t continued', findJoins([done, next], role).length === 0);
const sub = t('Every page', 96, 48, 96, 700, 110), subhead = t('reads in order', 40, 48, 200, 700, 48);
check('a smaller subtitle under a heading isn’t merged into it', findJoins([sub, subhead], role).length === 0);

const cap = t('T', 96, 48, 300, 60, 110), para = t('he report draws on national data and client data.', 21, 116, 300, 700, 120);
const dc = findJoins([cap, para], role);
check('a drop cap is read with its paragraph', dc.length === 1 && dc[0].kind === 'drop cap' && dc[0].pieces[0].sep === '', JSON.stringify(dc));
check('a capital before a capitalized paragraph is not a drop cap', findJoins([t('A', 96, 48, 300, 60, 110), t('Report summary for the year.', 21, 116, 300, 700, 120)], role).length === 0);

const cur = t('$', 30, 48, 300, 20, 40), num = t('120', 80, 70, 280, 130, 90), unit = t('K', 40, 204, 310, 30, 50);
const np = findJoins([cur, num, unit], role);
check('a number built from pieces is one number', np.length === 1 && np[0].kind === 'number' && np[0].pieces.length === 2, JSON.stringify(np));
const stats = [t('40%', 30, 1501, 201, 53, 38), t('36%', 30, 1571, 251, 52, 38), t('68%', 30, 1645, 187, 53, 38)];
check('separate stats side by side stay separate', findJoins(stats, role).length === 0);

// ---- Letters typed apart, placeholders ----
check('letters typed apart are read as the word', spacedLetters('S P E C T E R') === 'SPECTER' && spacedLetters('R E A D Y') === 'READY');
check('two spaced words keep their gap', spacedLetters('S P E C T E R  O P S') === 'SPECTER OPS', String(spacedLetters('S P E C T E R  O P S')));
check('ordinary text isn’t touched', spacedLetters('A B testing') === null && spacedLetters('Level I') === null && spacedLetters('A B C') === null);
check('placeholder text is caught', ['Lorem ipsum dolor sit amet', 'Headline goes here', 'Your text here'].every((s) => PLACEHOLDER_TEXT.test(s)));
check('real text isn’t mistaken for a placeholder', !['Go here to register', 'Insert the card', 'Your title is yours'].some((s) => PLACEHOLDER_TEXT.test(s)));

// ---- Invisible, cropped, mirrored footers ----
const a = frame('A', [t('Visible heading for page A', 64, 48, 96, 800, 80), t('Ghost words', 16, 48, 400, 300, 24, { colorAlpha: 0 }), t('Cropped words', 16, 48, 500, 300, 24, { clipped: true }),
  t('Running title', 12, 48, 1030, 120, 16), t('Body text that carries the page and is long enough to be body text for sure.', 16, 48, 600, 800, 48)]);
const b = frame('B', [t('Visible heading for page B', 64, 48, 96, 800, 80), t('Running title', 12, 1920 - 48 - 120, 1030, 120, 16),
  t('Body text that carries the page and is long enough to be body text for sure.', 16, 48, 600, 800, 48)]);
const roles = suggestRoles([a, b]);
const r = (f: FrameState, text: string) => roles.get(f.items.find((i) => i.text === text)!.nodeId)?.role;
check('text with no visible fill isn’t read', r(a, 'Ghost words') === 'Artifact');
check('text cropped out by its frame isn’t read', r(a, 'Cropped words') === 'Artifact');
check('a footer that swaps sides on facing pages is still a footer', r(a, 'Running title') === 'Artifact' && r(b, 'Running title') === 'Artifact', `${r(a, 'Running title')}/${r(b, 'Running title')}`);

// ---- Bullets drawn as shapes ----
const bl = frame('L', [t('What changed this year', 16, 48, 100, 600, 24),
  t('Fewer handoffs between teams', 16, 72, 140, 600, 24, { bulleted: true }),
  t('Shorter review cycles', 16, 72, 172, 600, 24, { bulleted: true }),
  t('More work shipped in small batches', 16, 72, 204, 600, 24, { bulleted: true }),
  t('A closing paragraph that is not in the list.', 16, 48, 260, 600, 24)]);
const { lists } = suggestStructures([bl], (i) => i.role ?? 'P');
check('bullets drawn as shapes make a list', lists.length === 1 && lists[0].items.length === 3, JSON.stringify(lists.map((l) => l.items.length)));

// ---- Tagging: a joined heading is one element; a spaced word is spoken as the word ----
{
  const pdf = new Uint8Array(await readFile('samples/stress/01-split.pdf'));
  const texts = await readActualTexts(pdf);
  const at = (s: string) => texts.findIndex((x) => x === s);
  const item = (i: number, role: TextItem['role']): TextItem => ({ kind: 'text', nodeId: `x${i}`, text: texts[i], role });
  const a1 = at('Every page'), a2 = at('reads in order');
  const head: TextItem = { ...item(a1, 'H1'), joined: [{ item: item(a2, 'H1'), sep: ' ' }] };
  const rest = texts.map((_, i) => i).filter((i) => i !== a1 && i !== a2).map((i) => item(i, 'P'));
  const { pdf: out, report } = await buildTaggedPdf({ title: 'Joins', language: 'en-US', pages: [{ pdf, name: '01', items: [head, ...rest] as SemanticItem[] }] });
  await mkdir('out/edge', { recursive: true });
  await writeFile('out/edge/joined.pdf', out);
  check('joined pieces are all matched to the export', a1 >= 0 && a2 >= 0 && report.pages[0].unmatched.length === 0 && report.pages[0].defaulted.length === 0,
    `unmatched=${report.pages[0].unmatched.length} defaulted=${report.pages[0].defaulted.length}`);
  check('the joined heading becomes one bookmark with both lines', report.bookmarks >= 1);
  const { execSync } = await import('node:child_process');
  if (VERA) check('the joined PDF is PDF/UA-1 compliant', /isCompliant="true"/.test(execSync('bash tools/pdfua.sh out/edge/joined.pdf 2>&1').toString()));
}

// ---- Arabic: Figma's export leaves the words out; layers are paired with runs in layer order ----
{
  const frames = JSON.parse(await readFile('tools/stress-frames.json', 'utf8'));
  const f8 = frames.find((f: { name: string }) => f.name.startsWith('08'));
  const items: TextItem[] = f8.items.map((i: ItemState, k: number) => ({ kind: 'text', nodeId: i.nodeId, text: i.text!, layerIndex: k,
    role: k === 0 ? 'H1' : /stress test|^08$/.test(i.text!) ? 'Artifact' : 'P' }));
  const ordered = [items[0], items[1], items[2], items[3], items[4]]; // heading, right column, left column, footer
  const pdf = new Uint8Array(await readFile('samples/stress/08-arabic.pdf'));
  const { pdf: out, report } = await buildTaggedPdf({ title: 'Arabic', language: 'en-US', pages: [{ pdf, name: '08', items: ordered as SemanticItem[] }] });
  await writeFile('out/edge/arabic.pdf', out);
  check('Arabic layers are all matched though Figma left their text out', report.pages[0].unmatched.length === 0 && report.pages[0].defaulted.length === 0,
    `unmatched=${report.pages[0].unmatched.length} defaulted=${report.pages[0].defaulted.length}`);
  const { execSync } = await import('node:child_process');
  const said = execSync('python3 tools/readout.py out/edge/arabic.pdf').toString();
  check('Arabic is read in reading order from the layer’s own text', said.includes(items[1].text) && said.indexOf(items[0].text) < said.indexOf(items[1].text) && said.indexOf(items[1].text) < said.indexOf(items[2].text), said.split('\n').slice(4, 8).join(' / '));
  if (VERA) check('the Arabic PDF is PDF/UA-1 compliant', /isCompliant="true"/.test(execSync('bash tools/pdfua.sh out/edge/arabic.pdf 2>&1').toString()));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
