/**
 * What the export will say, before it's exported: a screen-reader transcript per page, the heading
 * outline, and a short report to keep with the PDF. All three are built from the same items the
 * tagger builds the PDF from, so the preview can't drift from the file.
 */
import { fullText, type SemanticItem, type TextItem } from './types.ts';
import { baseLang, languageName } from './checks.ts';
import { logoSvg } from './logo.ts';

export interface PreviewPage { name: string; frameId: string; items: SemanticItem[] }

export interface Line {
  /** What a screen reader announces before the words. */
  kind: 'heading' | 'text' | 'image' | 'table' | 'list' | 'row' | 'entry' | 'page';
  level?: number;
  text: string;
  /** The layer it comes from, to jump to. */
  nodeId?: string;
  lang?: string;
}

const clean = (s = '') => s.replace(/\s+/g, ' ').trim();
const words = (items: TextItem[]) => clean(items.map((t) => t.text).join(' '));

/** The reading of one page, in order, the way NVDA or VoiceOver would announce it. */
export function transcript(page: PreviewPage): Line[] {
  const out: Line[] = [];
  for (const it of page.items) {
    if (it.kind === 'text') {
      if (it.role === 'Artifact') continue;
      const h = /^H([1-6])$/.exec(it.role);
      out.push({ kind: h ? 'heading' : 'text', level: h ? Number(h[1]) : undefined, text: clean(it.spoken ?? fullText(it)), nodeId: it.nodeId, lang: it.lang });
    } else if (it.kind === 'image') {
      out.push({ kind: 'image', text: clean(it.alt), nodeId: it.nodeId });
    } else if (it.kind === 'table') {
      const cols = Math.max(...it.rows.map((r) => r.length), 0);
      out.push({ kind: 'table', text: `${it.rows.length} row${it.rows.length === 1 ? '' : 's'}, ${cols} column${cols === 1 ? '' : 's'}${it.caption ? ` — ${clean(it.caption.text)}` : ''}`, nodeId: it.rows.flat(2)[0]?.nodeId });
      const heads = it.headerRow ? it.headerRows ?? 1 : 0;
      // Two header rows (a merged heading over sub-columns): each column is named by both.
      const head = Array.from({ length: cols }, (_, j) => it.rows.slice(0, heads).map((r) => (r[j] ? words(r[j]) : '')).filter(Boolean).join(' '));
      it.rows.forEach((r, k) => {
        if (k < heads) return;
        // Screen readers pair each cell with its column header, so that's how a row is heard.
        const cells = r.map((c, j) => {
          const v = words(c) || 'blank';
          return head[j] && j > 0 ? `${head[j]}: ${v}` : v;
        });
        out.push({ kind: 'row', text: cells.join(' · '), nodeId: r.flat()[0]?.nodeId });
      });
    } else {
      out.push({ kind: 'list', text: `${it.items.length} item${it.items.length === 1 ? '' : 's'}`, nodeId: it.items[0]?.body[0]?.nodeId });
      for (const e of it.items) out.push({ kind: 'entry', text: clean(`${e.label ? e.label.text + ' ' : ''}${words(e.body)}`), nodeId: e.body[0]?.nodeId });
    }
  }
  return out;
}

/** How a line is spoken: "Heading level 2, …", "Image, …", "Table, 5 rows, 3 columns". */
export function spoken(line: Line): string {
  const lang = line.lang ? ` (${languageName(line.lang)})` : '';
  switch (line.kind) {
    case 'heading': return `Heading level ${line.level}${lang}, ${line.text}`;
    case 'image': return `Image, ${line.text}`;
    case 'table': return `Table, ${line.text}`;
    case 'list': return `List, ${line.text}`;
    case 'page': return line.text;
    default: return `${lang ? lang.trim() + ' ' : ''}${line.text}`;
  }
}

export interface OutlineEntry { level: number; text: string; nodeId: string; frameId: string; page: string; skipped: boolean }

/** Every heading in the export, in order, with a flag on the ones that skip a level. */
export function outline(pages: PreviewPage[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let prev = 0;
  for (const p of pages)
    for (const it of p.items) {
      if (it.kind !== 'text') continue;
      const h = /^H([1-6])$/.exec(it.role);
      if (!h) continue;
      const level = Number(h[1]);
      out.push({ level, text: clean(it.spoken ?? fullText(it)), nodeId: it.nodeId, frameId: p.frameId, page: p.name, skipped: level > prev + 1 });
      prev = level;
    }
  return out;
}

export interface ReportInput {
  title: string;
  language: string;
  fileName: string;
  pages: PreviewPage[];
  /** Things still flagged at export time. */
  openIssues: Array<{ page: string; text: string }>;
  /** Choices made on purpose, e.g. "Low contrast accepted as a design choice". */
  decisions: string[];
  quality: string;
  sizeBytes?: number;
  /** Figures actually tagged in the PDF (the export's count); else counted from the items. */
  figuresTagged?: number;
  /** Problems the export ran into (an image it couldn't find, text added at the end). */
  exportWarnings?: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Report colors: light, then dark (a report opened at night shouldn't glare). */
const REPORT_CSS = `
  :root {
    --bg: #ffffff; --panel: #f6f7fb; --line: #e6e8ef; --ink: #14151a; --ink-2: #545866; --ink-3: #6b6f7c;
    --blue: #002BFF; --blue-tint: #eef1ff; --blue-line: #c9d2ff;
    --ok: #0b7a46; --ok-tint: #e8f6ee; --ok-line: #b9e3cb;
    --warn: #9a4d00; --warn-tint: #fff3e0; --warn-line: #f5d29e;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1014; --panel: #171920; --line: #2a2d37; --ink: #f2f3f7; --ink-2: #b4b7c3; --ink-3: #9a9eab;
      --blue: #8ea2ff; --blue-tint: #1a2048; --blue-line: #33408a;
      --ok: #5fd39a; --ok-tint: #0f2a1d; --ok-line: #1f5a3c;
      --warn: #ffb35c; --warn-tint: #2e2110; --warn-line: #6b4a1c;
    }
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body { margin: 0 auto; max-width: 880px; padding: 40px 32px 56px; color: var(--ink); background: var(--bg);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  h1, h2, h3, p { margin: 0; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .logo-ink { fill: var(--ink); } .logo-blue { fill: var(--blue); }
  @media (prefers-color-scheme: light) { .logo-blue { fill: #002BFF; } }

  .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
  .top svg { display: block; }
  .doc-kind { font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }

  .hero { padding: 36px 0 28px; display: grid; gap: 10px; }
  .hero h1 { font-size: 34px; line-height: 1.15; font-weight: 650; letter-spacing: -.015em; max-width: 24ch; text-wrap: balance; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--ink-2); font-size: 14px; padding: 0; margin: 4px 0 0; list-style: none; }
  .meta li { display: inline-flex; gap: 6px; } .meta b { color: var(--ink); font-weight: 600; }

  .verdict { display: flex; gap: 16px; align-items: flex-start; padding: 20px 22px; border-radius: 14px; border: 1px solid; }
  .verdict.ok { background: var(--ok-tint); border-color: var(--ok-line); }
  .verdict.warn { background: var(--warn-tint); border-color: var(--warn-line); }
  .verdict .mark { flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; color: #fff; }
  .verdict.ok .mark { background: var(--ok); } .verdict.warn .mark { background: var(--warn); }
  .verdict .mark svg { width: 18px; height: 18px; }
  .verdict-title { font-size: 19px; font-weight: 650; line-height: 1.3; }
  .verdict.ok .verdict-title { color: var(--ok); } .verdict.warn .verdict-title { color: var(--warn); }
  .verdict p + p { margin-top: 4px; color: var(--ink-2); }
  @media (prefers-color-scheme: dark) { .verdict .mark { color: #0f1014; } }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 20px 0 0; padding: 0; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px 12px; display: flex; flex-direction: column-reverse; justify-content: flex-end; gap: 2px; }
  .tile dd { margin: 0; font-size: 30px; line-height: 1.1; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .tile dt { font-size: 13px; color: var(--ink-2); }
  .tile.lead { background: var(--blue-tint); border-color: var(--blue-line); } .tile.lead dd { color: var(--blue); }
  .tile.flag { background: var(--warn-tint); border-color: var(--warn-line); } .tile.flag dd { color: var(--warn); }

  section.block { margin-top: 40px; }
  .block > h2 { font-size: 13px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); padding-bottom: 10px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .block > h2 .count { font-size: 13px; letter-spacing: 0; text-transform: none; font-weight: 500; color: var(--ink-3); }

  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .facts th[scope=row] { width: 34%; font-weight: 500; color: var(--ink-2); padding-left: 0; }
  .facts td { padding-right: 0; }
  .pages thead th { font-size: 12px; font-weight: 600; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; border-bottom-color: var(--line); }
  .pages td.n, .pages th.n { text-align: right; font-variant-numeric: tabular-nums; width: 11%; }
  .pages td.n.zero { color: var(--ink-3); }
  .pages td:first-child, .pages th:first-child { padding-left: 0; width: 44px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .pages td:last-child, .pages th:last-child { padding-right: 0; }
  .pages tfoot td { font-weight: 650; border-bottom: 0; border-top: 2px solid var(--line); }

  .list { list-style: none; margin: 0; padding: 0; }
  .list li { display: flex; gap: 12px; align-items: baseline; padding: 11px 0; border-bottom: 1px solid var(--line); }
  .chip { flex: none; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); color: var(--ink-2); white-space: nowrap; }
  .flagged .chip { background: var(--warn-tint); border-color: var(--warn-line); color: var(--warn); }
  .note { display: flex; gap: 10px; align-items: baseline; }
  .note::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--blue); transform: translateY(-2px); }

  .outline { list-style: none; margin: 0; padding: 6px 0 0; }
  .outline li { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: baseline; padding: 7px 0; border-bottom: 1px dashed var(--line); }
  .outline .lvl { font-size: 11px; font-weight: 700; letter-spacing: .02em; color: var(--blue); background: var(--blue-tint); border: 1px solid var(--blue-line); border-radius: 6px; padding: 1px 6px; font-variant-numeric: tabular-nums; }
  .outline .h-text { font-weight: 500; }
  .outline li[data-level="1"] .h-text { font-weight: 650; }
  .outline .where { font-size: 13px; color: var(--ink-3); text-align: right; white-space: nowrap; }
  .skip { font-size: 12px; font-weight: 600; color: var(--warn); margin-left: 8px; white-space: nowrap; }
  .empty { padding: 14px 16px; margin-top: 12px; border-radius: 10px; background: var(--warn-tint); border: 1px solid var(--warn-line); color: var(--warn); font-weight: 600; }

  .todo { list-style: none; margin: 0; padding: 0; counter-reset: todo; }
  .todo li { display: grid; grid-template-columns: 22px 1fr; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .todo li::before { content: ""; width: 16px; height: 16px; margin-top: 3px; border: 1.5px solid var(--ink-3); border-radius: 4px; }
  .todo b { font-weight: 600; } .todo span { color: var(--ink-2); }

  .foot { margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; align-items: center; font-size: 13px; color: var(--ink-3); }
  .foot .made { display: inline-flex; align-items: center; gap: 8px; }
  .foot svg { display: block; }

  @media (max-width: 560px) { body { padding: 24px 16px 40px; } .hero h1 { font-size: 27px; } .pages .opt { display: none; } }
  @media print {
    :root { --bg: #fff; --panel: #f6f7fb; --ink: #14151a; }
    body { max-width: none; padding: 0; font-size: 12px; }
    .hero { padding: 24px 0 18px; } .hero h1 { font-size: 26px; }
    section.block { margin-top: 26px; break-inside: avoid-page; }
    .verdict, .tile, .chip, .lvl { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    @page { margin: 16mm 14mm; }
  }
`;

const ICON_OK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3.2 3.2L15 6.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 5.5v5.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.4" fill="currentColor"/></svg>';

/**
 * A one-page accessibility report to keep with the PDF: what was tagged, what was decided, what
 * still needs a person. For whoever asks "is this accessible?" later. Standalone HTML (no
 * network), readable on screen in light or dark, and on paper.
 */
export function reportHtml(r: ReportInput, date = new Date()): string {
  const all = r.pages.flatMap((p) => p.items);
  const texts = all.filter((i): i is TextItem => i.kind === 'text');
  const isHeading = (t: TextItem) => /^H[1-6]$/.test(t.role);
  const headings = texts.filter(isHeading).length;
  const figures = r.figuresTagged ?? all.filter((i) => i.kind === 'image').length;
  const tables = all.filter((i) => i.kind === 'table').length;
  const lists = all.filter((i) => i.kind === 'list').length;
  const skipped = texts.filter((t) => t.role === 'Artifact').length;
  const langs = [...new Set(texts.flatMap((t) => (t.lang && baseLang(t.lang) !== baseLang(r.language || 'en') ? [languageName(t.lang)] : [])))];
  const ol = outline(r.pages);
  const open = r.openIssues.length;
  const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const iso = date.toISOString().slice(0, 10);
  const day = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const row = (k: string, v: string) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`;
  const tile = (label: string, n: number, cls = '') => `<div class="tile${cls ? ' ' + cls : ''}"><dt>${esc(label)}</dt><dd>${n}</dd></div>`;
  const num = (n: number) => `<td class="n${n ? '' : ' zero'}">${n}</td>`;

  const perPage = r.pages.map((p, k) => {
    const t = p.items.filter((i): i is TextItem => i.kind === 'text');
    return {
      k: k + 1, name: p.name,
      headings: t.filter(isHeading).length, images: p.items.filter((i) => i.kind === 'image').length,
      tables: p.items.filter((i) => i.kind === 'table').length, lists: p.items.filter((i) => i.kind === 'list').length,
      skipped: t.filter((i) => i.role === 'Artifact').length,
    };
  });
  const sum = (key: 'headings' | 'images' | 'tables' | 'lists' | 'skipped') => perPage.reduce((n, p) => n + p[key], 0);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessibility report — ${esc(r.title)}</title>
<style>${REPORT_CSS}</style></head><body>
<header class="top">
  ${logoSvg('#14151a', '#002BFF', 22)}
  <span class="doc-kind">Accessibility report</span>
</header>
<main>
<section class="hero" aria-labelledby="doc-title">
  <h1 id="doc-title">${esc(r.title)}</h1>
  <ul class="meta">
    <li>File <b>${esc(r.fileName)}</b></li>
    <li>Exported <b><time datetime="${iso}">${esc(day)}</time></b></li>
    <li><b>${plural(r.pages.length, 'page')}</b></li>
    ${r.sizeBytes ? `<li><b>${(r.sizeBytes / 1e6).toFixed(1)} MB</b></li>` : ''}
  </ul>
</section>

<section class="verdict ${open ? 'warn' : 'ok'}" aria-label="Result">
  <span class="mark">${open ? ICON_WARN : ICON_OK}</span>
  <div>
    <p class="verdict-title">${open ? `${open} item${open === 1 ? '' : 's'} still flagged at export` : 'Nothing left flagged at export'}</p>
    <p>${open ? 'The PDF is tagged, but these were left open in review. They’re listed below.' : 'Every item the review raised was settled before export.'} Tagged to the PDF/UA-1 structure (ISO 14289-1), with its title and language set.</p>
  </div>
</section>

<h2 class="sr-only">At a glance</h2>
<dl class="tiles">
  ${tile('Pages', r.pages.length, 'lead')}
  ${tile(headings === 1 ? 'Heading' : 'Headings', headings, headings ? '' : 'flag')}
  ${tile('Images with alt text', figures)}
  ${tile(tables === 1 ? 'Table' : 'Tables', tables)}
  ${tile(lists === 1 ? 'List' : 'Lists', lists)}
  ${tile('Skipped as decoration', skipped)}
</dl>

${open ? `<section class="block flagged" aria-labelledby="h-open"><h2 id="h-open">Still flagged <span class="count">${open}</span></h2>
<ul class="list">${r.openIssues.map((i) => `<li><span class="chip">${esc(i.page || 'Document')}</span><span>${esc(i.text)}</span></li>`).join('')}</ul></section>` : ''}

<section class="block" aria-labelledby="h-facts"><h2 id="h-facts">What’s in the PDF</h2>
<table class="facts">
${row('Standard', 'Tagged PDF, PDF/UA-1 (ISO 14289-1) structure')}
${row('Title', r.title)}
${row('Language', `${languageName(r.language)} (${r.language})`)}
${langs.length ? row('Passages in other languages', langs.join(', ')) : ''}
${row('Image quality', r.quality)}
${r.sizeBytes ? row('File size', `${(r.sizeBytes / 1e6).toFixed(1)} MB`) : ''}
</table></section>

${r.decisions.length ? `<section class="block" aria-labelledby="h-dec"><h2 id="h-dec">Decisions made on purpose</h2>
<ul class="list">${r.decisions.map((d) => `<li class="note">${esc(d)}</li>`).join('')}</ul></section>` : ''}

${r.exportWarnings?.length ? `<section class="block flagged" aria-labelledby="h-warn"><h2 id="h-warn">Export warnings <span class="count">${r.exportWarnings.length}</span></h2>
<ul class="list">${r.exportWarnings.map((w) => `<li><span class="chip">Warning</span><span>${esc(w)}</span></li>`).join('')}</ul></section>` : ''}

<section class="block" aria-labelledby="h-pages"><h2 id="h-pages">Page by page</h2>
<table class="pages">
<thead><tr><th scope="col">#</th><th scope="col">Page</th><th scope="col" class="n">Headings</th><th scope="col" class="n">Images</th><th scope="col" class="n opt">Tables</th><th scope="col" class="n opt">Lists</th><th scope="col" class="n opt">Skipped</th></tr></thead>
<tbody>${perPage.map((p) => `<tr><td>${p.k}</td><th scope="row" style="font-weight:500">${esc(p.name)}</th>${num(p.headings)}${num(p.images)}${num(p.tables).replace('class="n', 'class="opt n')}${num(p.lists).replace('class="n', 'class="opt n')}${num(p.skipped).replace('class="n', 'class="opt n')}</tr>`).join('')}</tbody>
${perPage.length > 1 ? `<tfoot><tr><td></td><td>Total</td><td class="n">${sum('headings')}</td><td class="n">${sum('images')}</td><td class="n opt">${sum('tables')}</td><td class="n opt">${sum('lists')}</td><td class="n opt">${sum('skipped')}</td></tr></tfoot>` : ''}
</table></section>

<section class="block" aria-labelledby="h-outline"><h2 id="h-outline">Heading outline <span class="count">${plural(ol.length, 'heading')}</span></h2>
${ol.length ? `<ol class="outline">${ol.map((h) => `<li data-level="${h.level}" style="padding-left:${(h.level - 1) * 22}px"><span class="lvl">H${h.level}</span><span class="h-text">${esc(h.text)}${h.skipped ? '<span class="skip">skips a level</span>' : ''}</span><span class="where">${esc(h.page)}</span></li>`).join('')}</ol>`
  : '<p class="empty">No headings — a screen reader user can’t jump through this document.</p>'}
</section>

<section class="block" aria-labelledby="h-todo"><h2 id="h-todo">Still needs a person</h2>
<ul class="todo">
<li><div><b>Alt text says what matters.</b> <span>A tool can check that every image has a description, not that the description is right.</span></div></li>
<li><div><b>Reading order on complex layouts.</b> <span>Listen to a page or two with NVDA, JAWS or VoiceOver.</span></div></li>
<li><div><b>A second checker.</b> <span>PAC 2024 (Windows) adds checks beyond veraPDF; run it before claiming conformance.</span></div></li>
</ul></section>
</main>

<footer class="foot">
  <span class="made">Made with ${logoSvg('#14151a', '#002BFF', 13)}</span>
  <span>A free accessibility plugin for Figma design. Everything ran inside Figma; nothing was uploaded.</span>
</footer>
</body></html>`;
}
