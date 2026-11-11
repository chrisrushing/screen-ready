/**
 * Plugin UI iframe. Two tabs: Content (roles, reading order, alt text — the per-export review) and
 * Export (title, language, pages, image quality, color — set once per file). Builds the tagged PDF from
 * Figma's native export, entirely in the browser; no network access.
 */
import { buildTaggedPdf } from './tagger.ts';
import { nestChartTitles, shiftToH1, suggestImages, suggestRoles } from './suggest.ts';
import { suggestStructures, type ListSuggestion, type TableSuggestion } from './structures.ts';
import { isFigure, structureMembers, toItems } from './items.ts';
import { draftChartAlt } from './chartdata.ts';
import { altCoversLabels, labelsSentence } from './diagrams.ts';
import { hydrateIcons, icon } from './icons.ts';
import { findJoins, PLACEHOLDER_TEXT, repeatedParagraphs, spacedLetters } from './joins.ts';
import { baseLang, checkAlt, checkLinkText, detectScriptLanguage, findCitations, findSources, isSourcesName, LANGUAGE_NAMES, languageName, SCRIPT_SHARED_BY, type SourceEntry } from './checks.ts';
import { outline, reportHtml, spoken, transcript, type PreviewPage } from './preview.ts';
import { checkContrast, formatRatio, type ContrastInput, type ContrastResult } from './contrast.ts';
import { PRESETS, type ImageCodec, type QualityPreset } from './compress.ts';
import type { DocumentInput, TextRole } from './types.ts';
import type { ColorProfile, DocState, FrameState, ItemState, ToSandbox, ToUI } from './messages.ts';

const ROLES: TextRole[] = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'Artifact'];
const ROLE_LABEL: Partial<Record<TextRole, string>> = { P: 'Text', Artifact: 'Skip' };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let frames: FrameState[] = [];
/** The page's other frames (text only): context for the document-wide heading scale. */
let context: FrameState[] = [];
let doc: DocState = { title: '', language: 'en-US', quality: 'original', colorProfile: 'DOCUMENT', styleRoles: {} };
let fileName = '';
let source: 'selection' | 'page' = 'page';
const thumbs = new Map<string, { bytes: Uint8Array; url: string }>();
/** Tables and lists found on the frames being exported (minus the ones the designer turned off). */
let tables: TableSuggestion[] = [];
/** Contrast per text layer, measured on a render of its frame (WCAG AA). */
const contrast = new Map<string, ContrastResult>();
let contrastChecking = false;
let contrastDone = 0;
/** Results per frame, kept while the frame's text (position, color, size) is unchanged. */
const contrastCache = new Map<string, { sig: string; results: ContrastResult[] }>();
let lists: ListSuggestion[] = [];

/** "To review" shows only what needs attention; "Everything" shows every layer in reading order. */
let view: 'review' | 'all' = 'review';
/** Rows fixed a moment ago stay in the to-do list, marked done, until you move on. */
const justFixed = new Set<string>();
/** Page-level frames open in the Everything view (only the page you're on, unless you open more). */
const openFrames = new Set<string>();
/** Pages you folded away in the To review view. */
const closedInReview = new Set<string>();
/** The page you're on: where the canvas selection is, or where Back/Next last went. */
let currentFrameId = '';
/** Every frame the export could include, in order, and which are left out (Export → Pages). */
let pagesList: Array<{ id: string; name: string; skip: boolean }> = [];

const send = (msg: ToSandbox) => parent.postMessage({ pluginMessage: msg }, '*');
const clean = (s = '') => s.replace(/\s+/g, ' ').trim();
const short = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const isHeading = (it: ItemState) => it.kind === 'text' && /^H[1-6]$/.test(it.role ?? '');
const isSkipped = (it: ItemState) => it.kind === 'text' && it.role === 'Artifact';
const needsAlt = (it: ItemState) => it.kind === 'image' && !it.decorative && !clean(it.alt);
const mb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

function announce(text: string) {
  const a = $('announce');
  a.textContent = '';
  requestAnimationFrame(() => (a.textContent = text));
}

// =============================================================================================
// Tabs
// =============================================================================================

const TABS = ['content', 'preview', 'export', 'about'] as const;
/**
 * The start screen: before anything is read, a reminder to leave only the frames to export on the
 * page, and the button that reads them. Skipped when the designer reads as soon as it opens.
 */
let readyInfo: Extract<ToUI, { type: 'ready' }> | null = null;
function setStage(stage: 'boot' | 'start' | 'work') {
  document.body.dataset.stage = stage;
}
function renderStart() {
  const r = readyInfo;
  if (!r) return;
  const n = r.selected || r.frames;
  const plural = (k: number) => `${k} frame${k === 1 ? '' : 's'}`;
  const scope = $('start-scope');
  scope.replaceChildren();
  const b = (t: string) => el('b', '', t);
  if (r.selected) scope.append(b(plural(r.selected)), ' selected on ', b(r.pageName));
  else if (r.frames) scope.append(b(r.pageName), ' has ', b(plural(r.frames)), '. Select some to read just those.');
  else scope.append(b(r.pageName), ' has no frames yet. Add one, or open the page you’re exporting.');
  const go = $<HTMLButtonElement>('start-go');
  go.textContent = r.selected ? `Read ${plural(r.selected)}` : r.frames ? `Read ${plural(r.frames)}` : 'Read this page';
  go.disabled = n === 0;
}
function syncAutoRead(on: boolean) {
  for (const id of ['start-auto', 'auto-read']) $<HTMLInputElement>(id).checked = on;
}
function setAutoRead(on: boolean) {
  syncAutoRead(on);
  send({ type: 'set-auto-read', on });
  announce(on ? 'Screen Ready will read the page as soon as it opens' : 'Screen Ready will open on the start screen');
}

function selectTab(name: (typeof TABS)[number], focus = false) {
  for (const t of TABS) {
    const tab = $(`tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  // The footer follows the tab (CSS): Back/Next on Review, the Export button on Export.
  document.body.dataset.tab = name;
  if (name === 'preview') renderPreview();
  if (name === 'export') renderExportStatus();
}
for (const t of TABS) {
  const tab = $(`tab-${t}`);
  tab.onclick = () => selectTab(t);
  tab.onkeydown = (e) => {
    const k = TABS.indexOf(t);
    const to = e.key === 'ArrowRight' ? (k + 1) % TABS.length : e.key === 'ArrowLeft' ? (k + TABS.length - 1) % TABS.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    selectTab(TABS[to], true);
  };
}
document.body.dataset.tab = 'content';

$('options-toggle').addEventListener('click', () => {
  const b = $('options-toggle');
  const open = b.getAttribute('aria-expanded') !== 'true';
  b.setAttribute('aria-expanded', String(open));
  $('review-options').hidden = !open;
});
$('to-export').addEventListener('click', () => selectTab('export', true));

/** Top of the Export tab: whether review is done, and what's still open (export is never blocked). */
function renderExportStatus(issues = frames.length ? findIssues() : []) {
  const host = $('export-status');
  host.textContent = '';
  if (!frames.length) return;
  if (!issues.length) {
    const ready = el('div', 'ready with-icon');
    ready.append(icon('circle-check', 14), 'Everything is reviewed');
    host.appendChild(ready);
    host.appendChild(el('p', undefined, 'Check Preview to hear it the way a screen reader will, then export.'));
    return;
  }
  host.appendChild(el('div', 'open', `${issues.length} item${issues.length === 1 ? '' : 's'} still to review`));
  host.appendChild(el('p', undefined, 'You can export now; they’ll be listed in the accessibility report.'));
  const go = el('button', 'fix-btn', 'Go to review') as HTMLButtonElement;
  go.type = 'button';
  go.onclick = () => selectTab('content', true);
  host.appendChild(go);
}

/** "✓ Done": a row settled a moment ago. */
function doneNote(cls = ''): HTMLElement {
  const n = el('div', `fixed-note with-icon${cls ? ' ' + cls : ''}`);
  n.append(icon('check', 12), 'Done');
  return n;
}

/** Show / hide the layers folded under a row: a chevron that turns when open. */
function foldButton(open: boolean): HTMLButtonElement {
  const b = el('button', 'icon-btn fold') as HTMLButtonElement;
  b.type = 'button';
  b.appendChild(icon('chevron-down', 16));
  b.setAttribute('aria-expanded', String(open));
  b.setAttribute('aria-label', open ? 'Hide the layers' : 'Show the layers');
  b.title = open ? 'Hide' : 'Show';
  return b;
}

/** The Review tab's count: what's left, or ✓. Part of the tab's name for screen readers. */
function syncReviewCount(issues: Issue[]) {
  const badge = $('review-count');
  const tab = $('tab-content');
  if (!frames.length) { badge.textContent = ''; tab.removeAttribute('aria-label'); return; }
  badge.textContent = issues.length ? String(issues.length) : '';
  if (!issues.length) badge.appendChild(icon('check', 12));
  badge.classList.toggle('done', !issues.length);
  tab.setAttribute('aria-label', issues.length ? `Review, ${issues.length} to review` : 'Review, all reviewed');
}

// =============================================================================================
// Suggestions
// =============================================================================================

/**
 * Fills in suggestions for everything the designer hasn't decided: a role for each text layer,
 * and decorative-or-not (plus alt text for logos) for each image and logo.
 */
function applySuggestions() {
  // Learn the heading scale from the whole page, in page order, then apply it to the frames here.
  const whole = [...frames, ...context].sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0));
  const roles = suggestRoles(whole);
  shiftToH1(frames, roles);
  const images = suggestImages(whole);
  for (const f of frames)
    for (const it of f.items) {
      if (it.kind === 'text') it.spoken = spacedLetters(it.text ?? '') ?? undefined;
      if (it.kind === 'text' && !it.roleSet) {
        const s = roles.get(it.nodeId);
        const rule = doc.styleRoles?.[styleLabel(it)];
        it.ruled = !!rule;
        it.role = rule ?? s?.role ?? 'P';
        it.reason = rule ? `File rule: “${styleLabel(it)}” is ${ROLE_LABEL[rule] ?? rule}` : s?.reason ?? 'Default';
      } else if (it.kind === 'image' && !it.decided) {
        const s = images.get(it.nodeId);
        it.decorative = s?.decorative ?? false;
        it.alt = s?.alt ?? '';
        it.suggestion = s?.reason;
        it.nameDraft = !!s?.draft;
      }
    }
  nestChartTitles(frames);
  draftChartAlts();
  draftDiagramAlts();
  detectLanguages();
  findStructures();
}

/**
 * A starting point for each undecided chart's alt text, built from its own labels (values paired
 * with categories, the series from the legend). It's marked as a draft until someone edits it.
 */
function draftChartAlts() {
  for (const f of frames)
    f.items.forEach((it, k) => {
      if (!it.chart || it.decided) return;
      const labels = f.items.filter((i) => i.inChart === it.nodeId);
      if (!labels.length) return;
      // The chart's title: the top-level heading before it in the same block (not its subtitle).
      let title: string | undefined;
      let best = 7;
      for (let j = k - 1; j >= 0 && f.items[j].group === it.group; j--) {
        const level = isHeading(f.items[j]) ? Number(f.items[j].role![1]) : 7;
        if (level <= best && level < 7) { best = level; title = clean(f.items[j].text); }
      }
      const draft = draftChartAlt(labels, it.bbox, title);
      it.alt = draft.alt;
      it.suggestion = draft.confidence === 'paired'
        ? 'Drafted from the chart’s labels — check it says what matters'
        : 'Drafted from the chart’s values — say what the chart shows';
    });
}

/** A diagram's labels as one string: what was approved, so the same labels aren't drafted in again. */
function labelsKey(f: FrameState, it: ItemState): string {
  const textOf = new Map(f.items.map((i) => [i.nodeId, clean(i.text)]));
  return (it.labelUnits ?? []).map((u) => u.map((id) => textOf.get(id) ?? '').join(' / ')).join('\n');
}

/**
 * A diagram's labels are read as part of it, so its alt text has to say them: they're added to it
 * (or make up a first draft), marked as a draft until someone approves or edits it. Labels already
 * named in the alt text, or approved before, are left alone.
 */
function draftDiagramAlts() {
  for (const f of frames)
    for (const it of f.items) {
      it.labelsDraft = false;
      if (!it.diagram || it.decorative || !it.labelUnits?.length) continue;
      const key = labelsKey(f, it);
      if (it.labelsChecked === key) continue;
      const textOf = (id: string) => f.items.find((i) => i.nodeId === id)?.text ?? '';
      const base = clean(it.alt);
      if (base && altCoversLabels(base, it.labelUnits.flat().map(textOf))) continue;
      it.alt = [base && !/[.!?:;…]$/.test(base) ? base + '.' : base, labelsSentence(it.labelUnits, textOf)].filter(Boolean).join(' ');
      it.labelsDraft = true;
      it.suggestion = base
        ? 'Its labels are read as part of it now, so they were added — check it reads well'
        : 'Drafted from its labels — add what the diagram shows';
    }
}

/** Waiting for a person to check: a drafted chart description, text-as-shapes alt, or a diagram's labels. */
const isDraft = (it: ItemState) =>
  it.kind === 'image' && !it.decorative && !!clean(it.alt) &&
  (((it.chart || it.outlined !== undefined || it.nameDraft) && !it.decided) || !!it.labelsDraft);

/**
 * Text in another script (Japanese, Arabic, Cyrillic…) is marked with its language, so a screen
 * reader switches voice. Same-script languages (a Spanish quote) are set by hand on the row.
 */
function detectLanguages() {
  const docLang = baseLang(doc.language || 'en-US');
  for (const f of frames)
    for (const it of f.items) {
      if (it.kind !== 'text' || it.langSet) continue;
      const found = detectScriptLanguage(it.text ?? '');
      it.lang = found && found !== docLang ? found : undefined;
    }
}

/**
 * Tables and lists, from the roles now in effect. A suggested heading inside one is a header cell
 * or an entry, not a heading, so it becomes text (the table or list carries the meaning).
 */
function findStructures() {
  const found = suggestStructures(frames, (i) => i.role);
  const off = (frameId: string, id: string) => !!frames.find((f) => f.id === frameId)?.structuresOff?.includes(id);
  tables = found.tables.filter((t) => !off(t.frameId, t.id));
  lists = found.lists.filter((l) => !off(l.frameId, l.id));
  const members = structureMembers(tables, lists);
  for (const f of frames)
    for (const it of f.items) {
      const kind = members.get(it.nodeId);
      if (kind && it.kind === 'text' && !it.roleSet && !it.ruled && /^H[1-6]$/.test(it.role ?? '')) {
        it.role = 'P';
        it.reason = kind === 'table' ? 'Part of a table — read as a cell' : 'Part of a list — read as a list entry';
      }
    }
  applyJoins(new Set(members.keys()));
}

/**
 * Text split across layers that reads as one thing (see joins.ts): a heading set one layer per
 * line, a drop cap, a number in pieces. The later pieces are read with the first.
 */
function applyJoins(inStructures: Set<string>) {
  const what = { heading: 'one heading set over several layers', 'drop cap': 'a drop cap and its paragraph', number: 'one number built from pieces' };
  for (const f of frames) {
    for (const it of f.items) { it.joinedTo = undefined; it.joinSep = undefined; }
    const byId = new Map(f.items.map((i) => [i.nodeId, i]));
    for (const j of findJoins(f.items, (i) => i.role, inStructures)) {
      const head = byId.get(j.head)!;
      // A drop cap reads as its paragraph does, not as the big letter it looks like; a "$" as its digits.
      const role = byId.get(j.lead)!.role ?? 'P';
      if (!head.roleSet) { head.role = role; head.reason = `Read with the next layer — ${what[j.kind]}`; }
      for (const p of j.pieces) {
        const it = byId.get(p.id)!;
        it.joinedTo = j.head;
        it.joinSep = p.sep;
        if (!it.roleSet) it.role = role;
        it.reason = `Read with “${short(clean(head.text), 24)}” — ${what[j.kind]}`;
      }
    }
  }
}

/** Turns a detected table or list off (or back on) for this frame, and remembers it. */
function setStructureOff(frame: FrameState, id: string, off: boolean) {
  remember(off ? 'Turn a table or list off' : 'Restore a table or list');
  const ids = new Set(frame.structuresOff ?? []);
  if (off) ids.add(id); else ids.delete(id);
  frame.structuresOff = [...ids];
  send({ type: 'set-structures-off', frameId: frame.id, ids: frame.structuresOff });
  applySuggestions();
  refreshFrame(frame);
  refreshSummary();
}

/** Puts every row back to its suggestion. */
function resetSuggestions() {
  remember('Reset all to suggestions');
  for (const f of frames)
    for (const it of f.items) {
      if (it.inherited) continue; // set on the main component; change it there
      if (it.kind === 'text' && it.roleSet) {
        it.roleSet = false;
        send({ type: 'set-role', nodeId: it.nodeId, role: '' as TextRole });
      } else if (it.kind === 'image' && it.decided) {
        it.decided = false;
        send({ type: 'set-decorative', nodeId: it.nodeId, decorative: null });
        send({ type: 'set-alt', nodeId: it.nodeId, alt: '' });
      }
    }
  applySuggestions();
  renderFrames();
  refreshSummary();
  announce('Everything reset to suggestions');
}

// =============================================================================================
// Status card: the machine-checkable rules that make Acrobat / PAC fail, in plain words.
// =============================================================================================

/** A one-click way to settle an issue, shown as a button on its row. */
interface Fix { label: string; run: () => void; /** Changes the Figma file itself; undo it in Figma. */ inFigma?: boolean }
interface Issue { level: 'error' | 'warn'; text: string; frameId: string; nodeId?: string; fixes?: Fix[] }

function setRole(item: ItemState, role: TextRole) {
  item.role = role;
  item.roleSet = true;
  item.inherited = false;
  send({ type: 'set-role', nodeId: item.nodeId, role });
}

/** Saves an image's alt text and decorative choice — for every copy of the same object. */
function commitImage(item: ItemState) {
  // A diagram's labels, approved with the alt text as it stands: not drafted in again.
  if (item.diagram) {
    const f = frames.find((fr) => fr.items.includes(item));
    item.labelsDraft = false;
    if (f) { item.labelsChecked = labelsKey(f, item); send({ type: 'set-labels-checked', nodeId: item.nodeId, labels: item.labelsChecked }); }
  }
  for (const other of sameObject(item)) {
    other.decided = true;
    other.decorative = item.decorative;
    other.alt = item.alt;
    send({ type: 'set-decorative', nodeId: other.nodeId, decorative: !!other.decorative });
    send({ type: 'set-alt', nodeId: other.nodeId, alt: other.alt ?? '', cleared: !clean(other.alt) });
  }
}

function findIssues(): Issue[] {
  const out: Issue[] = [];
  let prev = 0;
  let headings = 0;
  // The same object on many pages (a logo, a rule) is one question, asked once.
  const asked = new Set<string>();
  const once = (it: ItemState) => {
    if (it.kind !== 'image' || !it.signature) return true;
    if (asked.has(it.signature)) return false;
    asked.add(it.signature);
    return true;
  };
  const onPages = (it: ItemState) => {
    const n = it.signature ? frames.filter((f) => f.items.some((x) => x.signature === it.signature)).length : 1;
    return n > 1 ? ` (on ${n} pages)` : '';
  };
  // The level page titles usually have in this document (H1, or H2 under a document title).
  const tops = frames.map((f) => Math.min(...f.items.filter(isHeading).map((i) => Number(i.role![1])), 7)).filter((l) => l < 7);
  const usualTitle = tops.length ? [...tops].sort((a, b) => tops.filter((t) => t === b).length - tops.filter((t) => t === a).length)[0] : 1;
  for (const f of frames) {
    let frameHeadings = 0;
    for (const it of f.items) {
      if (isHeading(it)) {
        const lvl = Number(it.role!.slice(1));
        headings++;
        frameHeadings++;
        if (lvl > prev + 1) {
          const target = `H${prev + 1}` as TextRole;
          out.push({
            level: 'error', frameId: f.id, nodeId: it.nodeId,
            text: prev === 0 ? `The first heading is ${it.role}. Start with H1.`
              : `${it.role} comes right after H${prev}, skipping a level: “${short(clean(it.text), 30)}”`,
            fixes: [
              { label: `Make it ${target}`, run: () => setRole(it, target) },
              ...(prev > 0 ? [{ label: 'Make it text', run: () => setRole(it, 'P') }] : []),
            ],
          });
        }
        prev = lvl;
      }
      if (it.diagram && it.labelsDraft && isDraft(it)) {
        out.push({
          level: 'warn', frameId: f.id, nodeId: it.nodeId,
          text: `The labels on “${short(it.name, 24)}” (${short(f.name, 20)}) are read as part of it — check its alt text says them well.`,
          fixes: [{ label: 'Approve', run: () => commitImage(it) }],
        });
        continue;
      }
      if (it.nameDraft && isDraft(it) && once(it)) {
        out.push({
          level: 'warn', frameId: f.id, nodeId: it.nodeId,
          text: `“${short(clean(it.alt), 32)}” is from the layer name on “${short(f.name, 20)}”${onPages(it)} — check it says what the image shows.`,
          fixes: [{ label: 'Approve', run: () => commitImage(it) }],
        });
        continue;
      }
      if (it.chart && !it.decided && !it.decorative && clean(it.alt)) {
        out.push({
          level: 'warn', frameId: f.id, nodeId: it.nodeId, text: `Check the drafted alt text for the chart on “${short(f.name, 24)}”.`,
          fixes: [{ label: 'Approve', run: () => commitImage(it) }],
        });
      }
      if (it.kind === 'image' && (needsAlt(it) || (it.outlined !== undefined && !it.decided && !it.decorative)) && !once(it)) continue;
      if (it.outlined !== undefined && !it.decided && !it.decorative) {
        out.push({ level: 'warn', frameId: f.id, nodeId: it.nodeId,
          text: clean(it.alt) ? `Words drawn as shapes on “${short(f.name, 24)}” — check the alt text matches them.`
            : `Words drawn as shapes on “${short(f.name, 24)}” need alt text with the words.`,
          fixes: clean(it.alt) ? [{ label: 'Approve', run: () => commitImage(it) }] : undefined });
        continue;
      }
      if (needsAlt(it)) {
        out.push({
          level: 'warn', frameId: f.id, nodeId: it.nodeId,
          text: it.chart
            ? `A chart on “${short(f.name, 24)}” needs alt text — say what it shows and the numbers that matter.`
            : it.diagram
            ? `A diagram on “${short(f.name, 24)}” needs alt text — say what it shows, using its labels.`
            : it.vector
            ? `A logo on “${short(f.name, 24)}”${onPages(it)} needs alt text — the brand name is usually enough.`
            : `An image on “${short(f.name, 24)}”${onPages(it)} needs alt text, or mark it decorative.`,
          fixes: it.chart ? undefined : [{ label: 'Mark decorative', run: () => { it.decorative = true; commitImage(it); } }],
        });
      }
    }
    if (frameHeadings === 0 && f.items.some((i) => i.kind === 'text' && !isSkipped(i))) {
      // Point at the likely title, so reviewing it lands on something to fix, not the whole frame.
      const title = f.items.filter((i) => i.kind === 'text' && !isSkipped(i) && clean(i.text)).sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0))[0];
      // The biggest text is a quote or a paragraph: it isn't a title, and making it a heading would
      // fill the outline with a sentence. A page can go without a heading.
      if (title && clean(title.text).split(' ').length > 15) {
        const key = `nohead:${f.id}`;
        if (!isDismissed(key))
          out.push({ level: 'warn', frameId: f.id, nodeId: title.nodeId,
            text: `“${short(f.name, 24)}” has no heading. That’s fine for a quote page — keep the quote as text, not a heading.`,
            fixes: [keepAsIs(key)] });
        continue;
      }
      out.push({
        level: 'warn', frameId: f.id, nodeId: title?.nodeId,
        text: title
          ? `“${short(f.name, 24)}” has no heading. Is “${short(clean(title.text), 32)}” its title?`
          : `“${short(f.name, 28)}” has no heading, so screen reader users can't jump to it.`,
        fixes: title ? (() => {
          const level = `H${prev === 0 ? 1 : Math.min(usualTitle, prev + 1)}` as TextRole;
          return [{ label: `Yes, make it ${level}`, run: () => setRole(title, level) }];
        })() : undefined,
      });
    }
  }
  // Low contrast: listed one by one, or as one line per frame when there are many.
  for (const f of frames) {
    // Accepted as a design choice: measured and shown on the rows, but not something to review.
    const low = doc.acceptContrast ? [] : f.items.filter((it) => it.kind === 'text' && !isSkipped(it) && contrast.get(it.nodeId)?.pass === false);
    {
      for (const it of low) {
        const c = contrast.get(it.nodeId)!;
        out.push({
          level: 'warn', frameId: f.id, nodeId: it.nodeId,
          text: `Low contrast ${formatRatio(c.ratio!)} (needs ${c.required}:1)${c.mixed ? ' at its worst spot' : ''}: “${short(clean(it.text), 28)}”`,
        });
      }
    }
  }
  out.push(...contentIssues());
  if (frames.length && headings === 0) out.unshift({ level: 'error', frameId: frames[0].id, text: 'No headings yet. Mark the main title as H1.' });
  return out;
}

const isDismissed = (key: string) => !!doc.dismissed?.includes(key);
function dismiss(key: string) {
  doc.dismissed = [...new Set([...(doc.dismissed ?? []), key])];
  send({ type: 'set-doc', doc });
}
const keepAsIs = (key: string): Fix => ({ label: 'Keep as is', run: () => dismiss(key) });

/** The numbered sources a citation can link to, from a page named or titled like "Sources". */
function sourcesIndex(): Map<number, SourceEntry> {
  const pages = [...frames, ...context].filter((f) => isSourcesName(f.name) || f.items.some((i) => isHeading(i) && isSourcesName(i.text ?? '')));
  const out = new Map<number, SourceEntry>();
  for (const f of pages)
    for (const [n, e] of findSources(f.items.filter((i) => i.kind === 'text').map((i) => ({ nodeId: i.nodeId, text: i.text ?? '' }))))
      if (!out.has(n)) out.set(n, e);
  return out;
}

/** Citations that could link to their source and don't yet: one per marker. */
function unlinkedCitations() {
  const sources = sourcesIndex();
  const out: Array<{ frame: FrameState; item: ItemState; marker: string; start: number; end: number; source: SourceEntry }> = [];
  if (!sources.size) return out;
  for (const f of frames)
    for (const it of f.items) {
      if (it.kind !== 'text' || isSkipped(it) || sources.get(0)?.nodeId === it.nodeId) continue;
      if ([...sources.values()].some((src) => src.nodeId === it.nodeId)) continue; // the source entries themselves
      for (const c of findCitations(it.text ?? '')) {
        const source = sources.get(c.n);
        const linked = it.links?.some((l) => l.start <= c.start && l.end >= c.end);
        if (source && !linked && !isDismissed(`cite:${it.nodeId}:${c.start}`)) out.push({ frame: f, item: it, marker: c.marker, start: c.start, end: c.end, source });
      }
    }
  return out;
}

function linkCitation(c: ReturnType<typeof unlinkedCitations>[number]) {
  send({ type: 'link-citation', nodeId: c.item.nodeId, start: c.start, end: c.end, url: c.source.url, marker: c.marker });
  // Shown as linked right away; the re-read that follows confirms it.
  c.item.links = [...(c.item.links ?? []), { text: c.marker, url: c.source.url, start: c.start, end: c.end }];
}

/** What validators don't check but people notice: alt text quality, link wording, citations. */
function contentIssues(): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const f of frames) {
    const nearby = f.items.filter((i) => i.kind === 'text').map((i) => i.text ?? '');
    const repeated = new Set(repeatedParagraphs(f.items, isSkipped));
    for (const it of f.items) {
      // A heading is something to jump to: a whole quote or paragraph doesn't belong in that list.
      if (it.kind === 'text' && isHeading(it) && clean(it.text).split(' ').length > 25 && !isDismissed(`longhead:${it.nodeId}`)) {
        out.push({ level: 'warn', frameId: f.id, nodeId: it.nodeId,
          text: `A ${clean(it.text).split(' ').length}-word heading on “${short(f.name, 24)}” — headings are what screen reader users jump between. A quote or paragraph reads better as text.`,
          fixes: [{ label: 'Make it text', run: () => setRole(it, 'P') }, keepAsIs(`longhead:${it.nodeId}`)] });
      }
      if (it.kind === 'image' && isFigure(it) && (it.decided || !it.chart) && !it.labelsDraft) {
        if (it.signature && seen.has(it.signature)) continue;
        if (it.signature) seen.add(it.signature);
        const key = `alt:${it.signature || it.nodeId}`; // the same image everywhere: one key, whichever copy is first
        if (isDismissed(key)) continue;
        for (const p of checkAlt(it.alt ?? '', { chart: it.chart, logo: it.vector && !it.chart, nearbyText: nearby })) {
          out.push({
            level: 'warn', frameId: f.id, nodeId: it.nodeId, text: p.text,
            fixes: [
              ...(p.fixed ? [{ label: `Use “${short(p.fixed, 28)}”`, run: () => { it.alt = p.fixed; commitImage(it); } }] : []),
              keepAsIs(key),
            ],
          });
        }
      }
      // The same paragraph twice on one page (a copy left behind): read twice.
      if (repeated.has(it)) {
        const key = `twice:${it.nodeId}`;
        if (!isDismissed(key))
          out.push({ level: 'warn', frameId: f.id, nodeId: it.nodeId,
            text: `This paragraph appears twice on “${short(f.name, 24)}” — a screen reader reads it twice.`,
            fixes: [{ label: 'Skip this copy', run: () => setRole(it, 'Artifact') }, keepAsIs(key)] });
      }
      if (it.kind === 'text' && !isSkipped(it) && PLACEHOLDER_TEXT.test(it.text ?? '')) {
        out.push({ level: 'error', frameId: f.id, nodeId: it.nodeId,
          text: `Placeholder text left in on “${short(f.name, 24)}”: “${short(clean(it.text), 32)}”. Replace it in Figma, or skip it.`,
          fixes: [{ label: 'Skip it', run: () => setRole(it, 'Artifact') }] });
      }
      if (it.kind === 'text' && it.links?.length && !isSkipped(it)) {
        for (const l of it.links) {
          const key = `link:${it.nodeId}:${l.start}`;
          const problem = checkLinkText(l.text, it.text ?? l.text);
          if (problem && !isDismissed(key)) out.push({ level: 'warn', frameId: f.id, nodeId: it.nodeId, text: `${problem.text}. Edit the words in Figma.`, fixes: [keepAsIs(key)] });
        }
      }
    }
  }
  for (const c of unlinkedCitations()) {
    out.push({
      level: 'warn', frameId: c.frame.id, nodeId: c.item.nodeId,
      text: `Citation ${c.marker} isn't a link — link it to source ${c.source.n} (${short(c.source.url.replace(/^https?:\/\//, ''), 34)})`,
      fixes: [{ label: 'Link to source', run: () => linkCitation(c), inFigma: true }, keepAsIs(`cite:${c.item.nodeId}:${c.start}`)],
    });
  }
  return out;
}

/** The issues right now, and which layer each one is about. */
let issuesNow: Issue[] = [];
/** Every issue seen since the frames were read, and the ones since settled: the progress count. */
const seenIssues = new Set<string>();
const resolvedIssues = new Set<string>();

/** Recomputes the issues; a layer whose issue just went away is remembered as done for now. */
function refreshIssues(): Issue[] {
  const next = findIssues();
  const had = new Set(issuesByNode.keys());
  issuesByNode = new Map();
  for (const issue of next) if (issue.nodeId) issuesByNode.set(issue.nodeId, [...(issuesByNode.get(issue.nodeId) ?? []), issue]);
  for (const id of had) if (!issuesByNode.has(id)) justFixed.add(id);
  for (const id of issuesByNode.keys()) justFixed.delete(id);
  const keys = new Set(next.map(issueKey));
  for (const k of seenIssues) if (!keys.has(k)) resolvedIssues.add(k);
  for (const k of keys) { seenIssues.add(k); resolvedIssues.delete(k); }
  issuesNow = next;
  return next;
}

let lastIssueCount = -1;
function renderStatus() {
  const host = $('status');
  host.textContent = '';
  if (!frames.length) return;
  const issues = refreshIssues();
  // The card isn't a live region (it redraws on every keystroke); say only when the count changes.
  if (lastIssueCount >= 0 && issues.length !== lastIssueCount)
    announce(issues.length ? `${issues.length} to review` : 'Ready to export');
  lastIssueCount = issues.length;
  syncReviewNav(issues);
  $('review-view-count').textContent = issues.length ? String(issues.length) : '';
  $('view-review').setAttribute('aria-label', issues.length ? `To review, ${issues.length}` : 'To review');

  // Each page's header: how many things to review there, or a check mark.
  for (const f of frames) {
    const badge = document.querySelector<HTMLElement>(`.frame[data-frame-id="${CSS.escape(f.id)}"] .badge`);
    if (!badge) continue;
    const mine = issues.filter((i) => i.frameId === f.id);
    badge.hidden = false;
    badge.className = 'badge ' + (!mine.length ? 'ok' : mine.some((i) => i.level === 'error') ? 'error' : 'warn');
    badge.textContent = mine.length ? String(mine.length) : '✓';
    badge.title = mine.length ? `${mine.length} to review` : 'Nothing to review on this page';
  }

  const all = frames.flatMap((f) => f.items);
  const count = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const lowCount = all.filter((i) => i.kind === 'text' && !isSkipped(i) && contrast.get(i.nodeId)?.pass === false).length;
  const meta = [
    count(all.filter(isHeading).length, 'heading'),
    count(all.filter(isFigure).length, 'image'),
    ...(tables.length ? [count(tables.length, 'table')] : []),
    ...(lists.length ? [count(lists.length, 'list')] : []),
    contrastChecking ? `checking contrast ${contrastDone}/${frames.length}…` : lowCount ? `${lowCount} low contrast${doc.acceptContrast ? ' (accepted)' : ''}` : '',
  ].filter(Boolean).join(' · ');

  // One compact card: what's left, how far along you are, and what the export will contain.
  const errors = issues.some((i) => i.level === 'error');
  const card = el('div', `status ${!issues.length ? 'ok' : errors ? 'errors' : 'issues'}`);
  const top = el('div', 'status-top');
  const title = el('div', 'status-title');
  if (!issues.length) title.append(icon('circle-check', 14), 'Ready to export');
  else title.append(el('span', `dot ${errors ? 'error' : 'warn'}`), `${issues.length} to review`);
  top.appendChild(title);
  const done = resolvedIssues.size;
  const total = done + issues.length;
  if (done > 0 && total > 0) top.appendChild(el('span', 'status-done', `${done} of ${total} done`));
  card.appendChild(top);
  if (done > 0 && issues.length) {
    const bar = el('div', 'progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Review progress');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(total));
    bar.setAttribute('aria-valuenow', String(done));
    const fill = el('div', 'progress-fill');
    fill.style.width = `${Math.round((done / total) * 100)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
  }
  card.appendChild(el('div', 'status-meta', meta));
  // Several of the same kind of check at once: settle them in one click.
  const drafts = frames.flatMap((f) => f.items.filter(isDraft));
  const cites = unlinkedCitations();
  if (drafts.length >= 2 || cites.length >= 2) {
    const bulk = el('div', 'bulk');
    if (drafts.length >= 2) {
      const b = el('button', 'fix-btn', `Approve all ${drafts.length} drafted alt texts`);
      b.type = 'button';
      b.title = 'Accept every drafted alt text (charts, diagrams, text as shapes, layer names) as it is. Skim them first.';
      b.onclick = () => { remember(`Approve ${drafts.length} drafts`); for (const d of drafts) commitImage(d); changed(); announce(`${drafts.length} drafts approved`); focusAfterCard(); };
      bulk.appendChild(b);
    }
    if (cites.length >= 2) {
      const b = el('button', 'fix-btn', `Link all ${cites.length} citations`);
      b.type = 'button';
      b.title = 'Turn every citation marker into a link to its source’s web address. This changes the text layers in Figma (undo there with ⌘Z).';
      b.onclick = () => { for (const c of cites) linkCitation(c); changed(); announce(`${cites.length} citations linked`); focusAfterCard(); };
      bulk.appendChild(b);
    }
    card.appendChild(bulk);
  }
  // Contrast is about sighted low-vision readers, not screen readers, so it can be set aside on
  // purpose without hiding the rest of the review.
  if (lowCount && !contrastChecking) {
    const toggle = el('button', 'contrast-toggle' + (doc.acceptContrast ? ' undo' : ''), doc.acceptContrast ? 'Flag low contrast again' : 'Accept low contrast as a design choice');
    toggle.type = 'button';
    toggle.title = doc.acceptContrast
      ? 'Put low-contrast text back in the review list.'
      : 'Stop listing low-contrast text. It doesn\'t affect screen readers or the PDF/UA check, but it fails WCAG AA for readers with low vision.';
    toggle.onclick = () => { setAcceptContrast(!doc.acceptContrast); focusAfterCard(); };
    card.appendChild(toggle);
  }
  host.appendChild(card);
}

// =============================================================================================
// Contrast: each frame is rendered by the sandbox and measured here, in the background.
// =============================================================================================

const renders = new Map<string, (png: Uint8Array | null) => void>();
const requestRender = (frameId: string) =>
  new Promise<Uint8Array | null>((resolve) => {
    // Never wait forever: a frame that can't be rendered just goes unchecked.
    const timer = setTimeout(() => { renders.delete(frameId); resolve(null); }, 20000);
    renders.set(frameId, (png) => { clearTimeout(timer); resolve(png); });
    send({ type: 'render', frameId });
  });

let contrastRun = 0;
async function checkAllContrast() {
  const run = ++contrastRun;
  contrast.clear();
  contrastChecking = true;
  renderStatus();
  contrastDone = 0;
  for (const f of frames) {
    contrastDone++;
    const texts: ContrastInput[] = f.items.flatMap((it) =>
      it.kind === 'text' && it.color
        ? [{ id: it.nodeId, box: { x: it.bbox[0], y: f.height - it.bbox[3], w: it.bbox[2] - it.bbox[0], h: it.bbox[3] - it.bbox[1] },
             color: it.color, alpha: it.colorAlpha, fontSize: it.fontSize ?? 16, fontWeight: it.fontWeight ?? 400 }]
        : []);
    if (!texts.length) continue;
    // Rendering a frame takes about half a second, so unchanged frames reuse their results.
    const sig = JSON.stringify(texts.map((t) => [t.id, t.box, t.color, t.alpha, t.fontSize, t.fontWeight]));
    const cached = contrastCache.get(f.id);
    if (cached?.sig === sig) {
      for (const r of cached.results) contrast.set(r.id, r);
      continue;
    }
    renderStatus();
    try {
      const png = await requestRender(f.id);
      if (run !== contrastRun) return; // frames changed meanwhile; a newer run owns the results
      if (!png) continue;
      const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      if (run !== contrastRun) return;
      const canvas = el('canvas') as HTMLCanvasElement;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const g = canvas.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bitmap, 0, 0);
      bitmap.close();
      const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
      const results = checkContrast(data, canvas.width, canvas.height, canvas.width / (f.width || canvas.width), texts);
      contrastCache.set(f.id, { sig, results });
      for (const r of results) contrast.set(r.id, r);
    } catch {
      // A frame that can't be rendered just goes unchecked.
    }
  }
  if (run !== contrastRun) return;
  contrastChecking = false;
  renderFrames();
  refreshSummary();
}

// =============================================================================================
// Reading order on the canvas: numbered badges over the frames, kept in step with the panel.
// =============================================================================================

let showingOrder = false;
let overlayTimer = 0;

/** Each thing a screen reader stops at, in the order the export will read it. */
type Step = Extract<ToSandbox, { type: 'show-order' }>['frames'][number]['steps'][number];
function readingSteps(frame: FrameState): Step[] {
  const mine = <T extends { frameId: string }>(xs: T[]) => xs.filter((x) => x.frameId === frame.id);
  return toItems(frame, mine(tables), mine(lists)).flatMap((it): Step[] => {
    if (it.kind === 'text') return it.role === 'Artifact' ? [] : [{ ids: [it.nodeId], kind: /^H/.test(it.role) ? 'heading' : 'text' }];
    if (it.kind === 'image') return [{ ids: [it.nodeId], kind: 'figure' }];
    if (it.kind === 'table') return [{ ids: [...(it.caption ? [it.caption.nodeId] : []), ...it.rows.flat(2).map((t) => t.nodeId)], kind: 'table' }];
    return [{ ids: it.items.flatMap((e) => [...(e.label ? [e.label.nodeId] : []), ...e.body.map((t) => t.nodeId)]), kind: 'list' }];
  });
}

/** Redraws the badges (debounced, so dragging rows doesn't redraw on every step). */
function syncOverlay(now = false) {
  if (!showingOrder) return;
  clearTimeout(overlayTimer);
  const draw = () => send({ type: 'show-order', frames: frames.map((f) => ({ frameId: f.id, steps: readingSteps(f) })) });
  if (now) draw(); else overlayTimer = window.setTimeout(draw, 400);
}

$('show-order').addEventListener('click', () => {
  showingOrder = !showingOrder;
  const b = $('show-order');
  b.setAttribute('aria-pressed', String(showingOrder));
  b.textContent = showingOrder ? 'Hide order on canvas' : 'Show order on canvas';
  if (showingOrder) syncOverlay(true);
  else send({ type: 'show-order', frames: [] });
  announce(showingOrder ? 'Reading order shown on the canvas' : 'Reading order hidden');
});

// =============================================================================================
// Review navigator: Back / Next through the things to review, in order, panel and canvas together.
// =============================================================================================

let reviewIndex = -1;
/** The issue we're on, by identity, so fixing it (and the list shrinking) keeps your place. */
let reviewKey = '';
/** The issue we were on has just been settled: Next goes to the one that took its place. */
let reviewFixed = false;
const issueKey = (i: Issue) => `${i.frameId}|${i.nodeId ?? ''}|${i.text}`;

/** Shows issue n: its row in the panel (unfolded, flashed) and the object on the canvas. */
function goToIssue(n: number, focusRow = false) {
  const issues = findIssues();
  if (!issues.length) return syncReviewNav();
  reviewIndex = ((n % issues.length) + issues.length) % issues.length;
  const issue = issues[reviewIndex];
  reviewKey = issueKey(issue);
  reviewFixed = false;
  currentIssueNode = issue.nodeId ?? '';
  // Moving on: rows fixed a moment ago leave the to-do list, and the page you land on opens.
  justFixed.clear();
  if (view === 'all' && currentFrameId !== issue.frameId) { openFrames.clear(); openFrames.add(issue.frameId); }
  currentFrameId = issue.frameId;
  closedInReview.delete(issue.frameId);
  renderFrames();
  reveal(issue.frameId, issue.nodeId, true, focusRow);
  // The exact thing to review, close up on the canvas (a frame-wide issue shows the whole frame).
  send({ type: 'select', nodeIds: [issue.nodeId ?? issue.frameId], exact: !!issue.nodeId });
  syncReviewNav(issues);
  announce(`${reviewIndex + 1} of ${issues.length}: ${issue.text}`);
}

function syncReviewNav(issues = findIssues()) {
  const nav = $('review-nav');
  nav.hidden = !frames.length || !issues.length;
  $('to-export').hidden = !frames.length || !!issues.length;
  syncReviewCount(issues);
  if (document.body.dataset.tab === 'export') renderExportStatus(issues);
  if (nav.hidden) { reviewIndex = -1; reviewKey = ''; reviewFixed = false; return; }
  // Still on the same issue? Keep it. Settled? Step back one, so Next lands on the issue that
  // slid into its place instead of skipping it.
  const same = issues.findIndex((i) => issueKey(i) === reviewKey);
  if (same >= 0) reviewIndex = same;
  else if (reviewKey) { reviewIndex -= 1; reviewKey = ''; reviewFixed = true; }
  reviewIndex = Math.min(reviewIndex, issues.length - 1);
  const pos = $('review-pos');
  if (reviewKey) {
    const issue = issues[reviewIndex];
    pos.textContent = `${reviewIndex + 1} of ${issues.length} · ${issue.text}`;
    pos.title = issue.text;
  } else {
    pos.textContent = '';
    if (reviewFixed) pos.append(icon('check', 12, 'pos-done'), `Done · ${issues.length} left`);
    else pos.textContent = `${issues.length} to review`;
    pos.title = '';
  }
  $('review-next').querySelector('.label')!.textContent = reviewIndex < 0 && !reviewFixed ? 'Start' : 'Next';
  $<HTMLButtonElement>('review-prev').disabled = reviewIndex < 0;
}

// After a fix, the place we're on is already one back: Back goes to it, not past it.
$('review-prev').addEventListener('click', () => goToIssue(reviewFixed ? reviewIndex : reviewIndex - 1));
$('review-next').addEventListener('click', () => goToIssue(reviewIndex + 1));

/** After a status-card button redraws the card, land focus somewhere sensible, not the page body. */
function focusAfterCard() {
  const toggle = document.querySelector<HTMLElement>('.contrast-toggle');
  const next = $('review-next');
  (toggle ?? (next.closest('[hidden]') ? $('to-export') : next)).focus({ preventScroll: true });
}

function setAcceptContrast(accept: boolean) {
  remember(accept ? 'Accept low contrast' : 'Flag low contrast');
  $<HTMLInputElement>('flag-contrast').checked = !accept;
  saveDoc();
  refreshIssues();
  justFixed.clear(); // set aside, not fixed one by one
  renderFrames();
  refreshSummary();
  announce(accept ? 'Low contrast accepted; it is no longer in the review list' : 'Low contrast is back in the review list');
}

// =============================================================================================
// Undo: every decision in the panel can be stepped back (⌘Z / Ctrl+Z, or the Undo button).
// =============================================================================================

interface Snapshot {
  label: string;
  items: Map<string, { role?: TextRole; roleSet?: boolean; inherited?: boolean; alt?: string; decorative?: boolean; decided?: boolean; lang?: string; langSet?: boolean }>;
  frames: Map<string, { order: string[]; orderSet: boolean; off: string[] }>;
  doc: { styleRoles: Record<string, TextRole>; acceptContrast?: boolean; dismissed?: string[] };
}
const undoStack: Snapshot[] = [];

function snapshot(label: string): Snapshot {
  const items = new Map<string, Snapshot['items'] extends Map<string, infer V> ? V : never>();
  const fr = new Map<string, Snapshot['frames'] extends Map<string, infer V> ? V : never>();
  for (const f of frames) {
    fr.set(f.id, { order: f.items.map((i) => i.nodeId), orderSet: f.orderSet, off: [...(f.structuresOff ?? [])] });
    for (const i of f.items)
      items.set(i.nodeId, { role: i.role, roleSet: i.roleSet, inherited: i.inherited, alt: i.alt, decorative: i.decorative, decided: i.decided, lang: i.lang, langSet: i.langSet });
  }
  return { label, items, frames: fr, doc: { styleRoles: { ...(doc.styleRoles ?? {}) }, acceptContrast: doc.acceptContrast, dismissed: [...(doc.dismissed ?? [])] } };
}

/** Call before changing anything the designer decides. */
function remember(label: string) {
  undoStack.push(snapshot(label));
  if (undoStack.length > 50) undoStack.shift();
  syncUndo();
}

function syncUndo() {
  const b = $<HTMLButtonElement>('undo');
  b.disabled = !undoStack.length;
  b.title = undoStack.length ? `Undo: ${undoStack[undoStack.length - 1].label} (⌘Z)` : 'Nothing to undo';
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  for (const f of frames) {
    for (const it of f.items) {
      const was = snap.items.get(it.nodeId);
      if (!was) continue;
      if (it.kind === 'text' && (was.roleSet !== it.roleSet || (was.roleSet && was.role !== it.role))) {
        send({ type: 'set-role', nodeId: it.nodeId, role: (was.roleSet ? was.role : '') as TextRole });
        it.roleSet = was.roleSet; it.role = was.role; it.inherited = was.inherited;
      }
      if (it.kind === 'image' && (was.decided !== it.decided || was.alt !== it.alt || was.decorative !== it.decorative)) {
        send({ type: 'set-decorative', nodeId: it.nodeId, decorative: was.decided ? !!was.decorative : null });
        send({ type: 'set-alt', nodeId: it.nodeId, alt: was.decided ? was.alt ?? '' : '', cleared: !!was.decided && !clean(was.alt) });
        it.decided = was.decided; it.alt = was.alt; it.decorative = was.decorative;
      }
      if (it.kind === 'text' && (was.langSet !== it.langSet || was.lang !== it.lang)) {
        if (was.langSet !== it.langSet || was.langSet) send({ type: 'set-lang', nodeId: it.nodeId, lang: was.langSet ? was.lang ?? '' : '' });
        it.langSet = was.langSet; it.lang = was.lang;
      }
    }
    const fw = snap.frames.get(f.id);
    if (!fw) continue;
    if (fw.order.join() !== f.items.map((i) => i.nodeId).join() || fw.orderSet !== f.orderSet) {
      const at = new Map(fw.order.map((id, k) => [id, k]));
      f.items.sort((a, b) => (at.get(a.nodeId) ?? 1e9) - (at.get(b.nodeId) ?? 1e9));
      f.orderSet = fw.orderSet;
      send({ type: 'set-order', frameId: f.id, order: fw.orderSet ? fw.order : [] });
    }
    if (fw.off.join() !== (f.structuresOff ?? []).join()) {
      f.structuresOff = fw.off;
      send({ type: 'set-structures-off', frameId: f.id, ids: fw.off });
    }
  }
  doc = { ...doc, styleRoles: snap.doc.styleRoles, acceptContrast: snap.doc.acceptContrast, dismissed: snap.doc.dismissed };
  send({ type: 'set-doc', doc });
  applySuggestions();
  renderSettings();
  changed();
  syncUndo();
  announce(`Undone: ${snap.label}`);
}

$('undo').addEventListener('click', undo);
document.addEventListener('keydown', (e) => {
  // In a text box, ⌘Z undoes typing, as usual.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !(e.target as Element).closest('textarea, input')) {
    e.preventDefault();
    undo();
  }
});

/** Something was decided: redraw the rows (their notes and the to-do list) and the summary. */
function changed() {
  renderFrames();
  refreshSummary();
}

function setView(next: 'review' | 'all') {
  view = next;
  justFixed.clear();
  if (view === 'all' && !frames.some((f) => openFrames.has(f.id))) {
    const start = currentFrameId || issuesNow[0]?.frameId || frames[0]?.id;
    if (start) openFrames.add(start);
  }
  $('view-review').setAttribute('aria-pressed', String(view === 'review'));
  $('view-all').setAttribute('aria-pressed', String(view === 'all'));
  $('hints').hidden = view !== 'all';
  renderFrames();
  refreshSummary();
  announce(view === 'review' ? 'Showing only what needs review' : 'Showing every layer');
}
$('view-review').addEventListener('click', () => setView('review'));
$('view-all').addEventListener('click', () => setView('all'));

function refreshSummary() {
  syncOverlay();
  if (!$('panel-preview').hidden) renderPreview();
  renderStatus();
  const manual = frames.some((f) => f.items.some((i) => !i.inherited && ((i.kind === 'text' && i.roleSet) || (i.kind === 'image' && i.decided))));
  $('reset-suggestions').hidden = !manual;
  syncTitlePlaceholder();
}

/** Opens the frame, scrolls the row into view, flashes it and focuses its main control. */
function reveal(frameId: string, nodeId?: string, unfold = true, focus = true) {
  const frame = document.querySelector<HTMLElement>(`.frame[data-frame-id="${CSS.escape(frameId)}"]`);
  if (!frame) return;
  const f = frames.find((x) => x.id === frameId);
  if (frame instanceof HTMLDetailsElement && f) {
    frame.open = true;
    setOpen(f.id, true);
    ensureItems(frame, f);
  }
  // A row folded under a table, list, chart or pattern (Everything view): unfold it first.
  const it = f?.items.find((i) => i.nodeId === nodeId);
  if (unfold && view === 'all' && f && it && nodeId && !frame.querySelector(`.item[data-node-id="${CSS.escape(nodeId)}"]`)) {
    if (it.inChart) expandedStructures.add(it.inChart);
    for (const s of [...tables, ...lists]) if (JSON.stringify(s).includes(`"${nodeId}"`)) expandedStructures.add(s.id);
    expandedPatterns.add(f.id);
    expandedStructures.add(`repeats:${f.id}`);
    refreshFrame(f);
    return reveal(frameId, nodeId, false, focus);
  }
  const row = nodeId
    ? frame.querySelector<HTMLElement>(`.item[data-node-id="${CSS.escape(nodeId)}"]`)
    : frame.querySelector<HTMLElement>('.item');
  (row ?? frame).scrollIntoView({ block: row ? 'center' : 'start', behavior: 'smooth' });
  if (row) {
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    if (focus) row.querySelector<HTMLElement>('.fix-btn, .alt:not(:disabled), .role')?.focus({ preventScroll: true });
  }
}

// =============================================================================================
// Rows
// =============================================================================================

/**
 * Clicking anywhere on a row shows its layers on the canvas: selected, and in view. The drag
 * handle and the row's own links (Show, Not a table…) do their own thing instead.
 */
function jumpOnClick(row: HTMLElement, nodeIds: () => string[]) {
  row.classList.add('jumps');
  row.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.handle, .link, .fix-btn')) return;
    const ids = nodeIds();
    if (ids.length) send({ type: 'select', nodeIds: ids });
  });
}

function textRow(frame: FrameState, item: ItemState, index: number): HTMLElement {
  const li = el('li', 'item text-item' + (isHeading(item) ? ' heading' : '') + (isSkipped(item) ? ' skipped' : ''));
  li.dataset.nodeId = item.nodeId;
  const label = clean(item.text) || '(empty)';
  li.appendChild(handle(frame, index, label));

  const sel = el('select', 'role');
  sel.setAttribute('aria-label', `Role for “${short(label)}”`);
  const readAloud = el('optgroup') as HTMLOptGroupElement;
  readAloud.label = 'Read aloud';
  const notRead = el('optgroup') as HTMLOptGroupElement;
  notRead.label = 'Decorative — not read';
  for (const r of ROLES) {
    const o = Object.assign(el('option', undefined, ROLE_LABEL[r] ?? r), { value: r });
    (r === 'Artifact' ? notRead : readAloud).appendChild(o);
  }
  sel.append(readAloud, notRead);
  sel.value = item.role ?? 'P';
  const markSuggested = () => {
    sel.classList.toggle('suggested', !item.roleSet && !item.ruled);
    sel.title = item.inherited ? 'Set on the main component — every instance uses it. Pick a role to override here.'
      : item.roleSet ? ''
      : item.ruled ? `${item.reason}. Change the rule in Review → Options, or pick a role to override.`
      : `Suggested: ${item.reason}. Pick a role to override.`;
  };
  markSuggested();
  sel.onchange = () => {
    remember(`Set “${short(label, 24)}” to ${ROLE_LABEL[sel.value as TextRole] ?? sel.value}`);
    item.role = sel.value as TextRole;
    item.roleSet = true;
    item.inherited = false;
    markSuggested();
    li.classList.toggle('heading', isHeading(item));
    li.classList.toggle('skipped', isSkipped(item));
    send({ type: 'set-role', nodeId: item.nodeId, role: item.role });
    changed(); // other headings' notes can change too (levels are judged in order)
  };
  li.appendChild(sel);

  const cell = el('div', 'text-cell');
  const text = el('button', 'text', label);
  text.type = 'button';
  text.title = `${label}\n\nClick to show it on the canvas`;
  cell.append(text, el('div', 'skip-hint', 'Decorative · screen readers skip it'));
  attentionNote(item, cell, li);
  li.appendChild(cell);

  const size = el('span', 'size', `${Math.round(item.fontSize ?? 0)}`);
  size.title = 'Font size (pt)';
  size.setAttribute('aria-label', `${Math.round(item.fontSize ?? 0)} point`);
  const c = contrast.get(item.nodeId);
  if (c?.pass === false && !isSkipped(item)) {
    const warn = el('span', 'contrast-bad' + (doc.acceptContrast ? ' accepted' : ''), formatRatio(c.ratio!));
    warn.title = `Contrast ${formatRatio(c.ratio!)} — WCAG AA needs ${c.required}:1 for ${c.large ? 'large' : 'this size of'} text` +
      (c.mixed ? '. Measured at the worst spot of a busy background.' : '.');
    warn.setAttribute('aria-label', `Low contrast, ${formatRatio(c.ratio!)}`);
    size.prepend(warn);
  }
  li.appendChild(size);
  // Language: shown when it differs from the document's, or on hover in Everything.
  if (view === 'all' || item.lang) {
    const lang = el('select', 'lang-select' + (item.lang && item.lang !== '-' && baseLang(item.lang) !== baseLang(doc.language || 'en') ? ' set' : '')) as HTMLSelectElement;
    lang.setAttribute('aria-label', `Language of “${short(label)}”`);
    const docName = languageName(doc.language || 'en-US');
    lang.appendChild(Object.assign(el('option', undefined, `${docName} (document)`), { value: '-' }));
    for (const [code, name] of Object.entries(LANGUAGE_NAMES)) if (code !== baseLang(doc.language || 'en')) lang.appendChild(Object.assign(el('option', undefined, name), { value: code }));
    const own = item.lang && item.lang !== '-' && baseLang(item.lang) !== baseLang(doc.language || 'en') ? baseLang(item.lang) : '-';
    lang.value = own;
    lang.title = own !== '-'
      ? `Read with a ${languageName(own)} voice${item.langSet ? '' : SCRIPT_SHARED_BY[own] ? ` (a guess from the script — ${SCRIPT_SHARED_BY[own]} use it too; change it if so)` : ' (detected from the script)'}`
      : 'Language: same as the document. Change it for a quote or passage in another language.';
    lang.onchange = () => {
      remember(`Language of “${short(label, 24)}”`);
      item.lang = lang.value === '-' ? (detectScriptLanguage(item.text ?? '') ? '-' : undefined) : lang.value;
      item.langSet = true;
      send({ type: 'set-lang', nodeId: item.nodeId, lang: lang.value });
      changed();
      announce(lang.value === '-' ? 'Same language as the document' : `Read in ${languageName(lang.value)}`);
    };
    lang.addEventListener('click', (e) => e.stopPropagation());
    li.appendChild(lang);
  }
  jumpOnClick(li, () => [item.nodeId]);
  return li;
}

/** The issues being shown, by layer: so a row can say exactly what needs doing, right there. */
let issuesByNode = new Map<string, Issue[]>();
let currentIssueNode = '';

function attentionNote(item: ItemState, host: HTMLElement, row: HTMLElement) {
  const mine = issuesByNode.get(item.nodeId);
  if (!mine?.length) {
    // Settled a moment ago: it stays in the to-do list, marked done, until you move on.
    if (justFixed.has(item.nodeId)) {
      row.classList.add('fixed');
      host.appendChild(doneNote());
    }
    return;
  }
  row.classList.add('attention', mine.some((i) => i.level === 'error') ? 'error' : 'warn');
  if (item.nodeId === currentIssueNode) row.classList.add('current');
  for (const issue of mine) {
    host.appendChild(el('div', 'attention-note', issue.text));
    if (!issue.fixes?.length) continue;
    // The likely fix, one click away. The first is the recommendation.
    const bar = el('div', 'fixes');
    issue.fixes.forEach((fix, k) => {
      const b = el('button', 'fix-btn' + (k === 0 ? ' main' : ''), fix.label);
      b.type = 'button';
      // Many rows have an "Approve" — say which one, for screen readers' button lists.
      b.setAttribute('aria-label', `${fix.label}: ${short(issue.text, 70)}`);
      if (fix.inFigma) b.title = 'Changes the text layer in Figma; undo it there with ⌘Z.';
      b.onclick = () => {
        if (!fix.inFigma) remember(fix.label);
        fix.run();
        changed();
        announce(`Done: ${fix.label}`);
        // The button is gone; Next is the natural next step.
        const next = $('review-next');
        (next.closest('[hidden]') ? $('export') : next).focus({ preventScroll: true });
      };
      bar.appendChild(b);
    });
    host.appendChild(bar);
  }
}

/** Images opened for editing even though nothing is asked of them. */
const editingImages = new Set<string>();

/**
 * Nothing to do: described (or decorative) and not a draft waiting for a check. Shown as one
 * compact line — what a screen reader will say — with Edit, instead of an open editor.
 */
const isSettled = (it: ItemState) =>
  it.kind === 'image' && !needsAlt(it) && !editingImages.has(it.nodeId) &&
  !(it.chart && !it.decided && !it.decorative) && !(it.outlined !== undefined && !it.decided && !it.decorative) && !it.labelsDraft &&
  !(it.nameDraft && !it.decided && !it.decorative);

function imageRow(frame: FrameState, item: ItemState, index: number): HTMLElement {
  const li = el('li', 'item image' + (isSettled(item) ? ' settled' : ''));
  li.dataset.nodeId = item.nodeId;
  li.appendChild(handle(frame, index, `image ${item.name}`));

  const img = el('img', 'thumb') as HTMLImageElement;
  img.alt = '';
  if (item.thumb) {
    // A fresh read brings fresh bytes (the image may have changed): make a new preview for them.
    let t = thumbs.get(item.nodeId);
    if (!t || t.bytes !== item.thumb) {
      if (t) URL.revokeObjectURL(t.url);
      t = { bytes: item.thumb, url: URL.createObjectURL(new Blob([item.thumb], { type: 'image/png' })) };
      thumbs.set(item.nodeId, t);
    }
    img.src = t.url;
  }
  li.appendChild(img);

  const head = el('div', 'image-head');
  const name = el('button', 'text', item.name);
  name.type = 'button';
  name.title = 'Click to show it on the canvas';
  const state = el('div', 'image-state');
  head.append(name, state);
  attentionNote(item, head, li);
  li.appendChild(head);

  if (isSettled(item)) {
    const kind = item.chart ? 'Chart' : item.diagram ? 'Diagram' : item.outlined !== undefined ? 'Text as shapes' : item.vector ? 'Logo' : 'Image';
    state.textContent = item.decorative ? `${kind} · decorative, skipped` : `${kind} · reads “${short(clean(item.alt), 60)}”`;
    state.title = item.decorative ? '' : clean(item.alt);
    const edit = el('button', 'icon-btn edit-image');
    edit.type = 'button';
    edit.appendChild(icon('pencil', 14));
    edit.title = 'Edit alt text';
    edit.setAttribute('aria-label', `Edit alt text for ${item.name}`);
    edit.onclick = () => {
      editingImages.add(item.nodeId);
      refreshFrame(frame);
      document.querySelector<HTMLElement>(`.item[data-node-id="${CSS.escape(item.nodeId)}"] .alt:not(:disabled), .item[data-node-id="${CSS.escape(item.nodeId)}"] .check input`)?.focus();
    };
    li.appendChild(edit);
    jumpOnClick(li, () => [item.nodeId]);
    return li;
  }

  const body = el('div', 'image-body');
  const alt = el('textarea', 'alt') as HTMLTextAreaElement;
  alt.value = item.alt ?? '';
  alt.placeholder = item.chart
    ? 'What the chart shows and the numbers that matter, e.g. “Bar chart: filings rose from 274K in 2021 to 780K in 2024.”'
    : item.diagram ? 'What the diagram shows, in words its labels use, e.g. “Data flows from the sign-up form through the API to the database.”'
    : item.outlined !== undefined ? 'The words, exactly as they read'
    : item.vector ? 'Name the brand, e.g. “Acme logo”' : 'Describe what this image shows…';
  alt.rows = 2;
  alt.setAttribute('aria-label', `Alt text for ${item.name}`);
  const check = el('label', 'check');
  const box = el('input') as HTMLInputElement;
  box.type = 'checkbox';
  box.checked = !!item.decorative;
  check.append(box, 'Decorative — screen readers skip it');

  const why = el('div', 'suggest-why');
  const sync = () => {
    const suggested = (!item.decided || !!item.labelsDraft) && !!item.suggestion;
    alt.disabled = !!item.decorative;
    alt.value = item.alt ?? '';
    box.checked = !!item.decorative;
    alt.classList.toggle('suggested', suggested && !item.decorative && !!clean(item.alt));
    check.classList.toggle('suggested', suggested && !!item.decorative);
    state.className = 'image-state' + (needsAlt(item) ? ' needs' : '');
    const what = item.decorative ? 'Decorative' : clean(item.alt) ? 'Figure with alt text' : 'Needs alt text';
    state.textContent = (item.chart ? 'Chart · ' : item.diagram ? 'Diagram · ' : item.outlined !== undefined ? 'Text as shapes · ' : item.vector ? 'Logo · ' : '') + what;
    why.textContent = suggested ? `Suggested: ${item.suggestion}` : '';
    why.hidden = !suggested;
  };
  // Any edit is a decision; from then on suggestions leave this image alone.
  let saveTimer = 0;
  const decide = () => {
    clearTimeout(saveTimer);
    commitImage(item);
    refreshSummary();
  };
  // Saved as you type (a moment after you stop), so a re-read or re-render can't lose it.
  let typing: Snapshot | null = null;
  alt.onfocus = () => { typing = snapshot(`Alt text for ${short(item.name, 24)}`); };
  alt.oninput = () => {
    if (typing) { undoStack.push(typing); typing = null; syncUndo(); }
    item.alt = alt.value;
    item.decided = true;
    // Typing a description is the approval: the row turns green right away (and stays done).
    const typed = !!clean(alt.value);
    li.classList.toggle('typed', typed);
    if (typed) justFixed.add(item.nodeId);
    if (typed && !head.querySelector('.typed-note, .fixed-note')) head.appendChild(doneNote('typed-note'));
    sync();
    renderStatus();
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(decide, 600);
  };
  // Done typing: the row settles into one line, its copies and a chart's labels follow. Redrawn a
  // tick later, once focus has landed where it was going, so it can be kept there.
  alt.onchange = () => {
    decide();
    setTimeout(renderFrames, 0);
  };
  box.onchange = () => {
    remember(`${box.checked ? 'Mark' : 'Unmark'} ${short(item.name, 24)} decorative`);
    item.decorative = box.checked;
    if (!box.checked) editingImages.add(item.nodeId); // stay open, to type the alt text
    decide();
    if (sameObject(item).length > 1) announce(`${box.checked ? 'Skipped' : 'Read'} on all ${sameObject(item).length} pages`);
    renderFrames();
    if (!box.checked) document.querySelector<HTMLTextAreaElement>(`.item[data-node-id="${CSS.escape(item.nodeId)}"] .alt`)?.focus();
  };
  sync();
  body.append(alt, check, why);
  li.appendChild(body);
  jumpOnClick(li, () => [item.nodeId]);
  return li;
}

// =============================================================================================
// Reordering: drag the handle, or focus it and use the arrow keys.
// =============================================================================================

function handle(frame: FrameState, index: number, label: string): HTMLButtonElement {
  const h = el('button', 'handle');
  h.appendChild(icon('grip-vertical', 14));
  h.type = 'button';
  h.title = 'Drag to reorder, or press ↑ ↓';
  h.setAttribute('aria-label', `Reorder “${short(label)}”, position ${index + 1} of ${frame.items.length}. Use up and down arrows to move.`);
  h.onkeydown = (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveItem(frame, index, index + (e.key === 'ArrowUp' ? -1 : 1));
    }
  };
  h.onpointerdown = (e) => startDrag(e, frame, index, h);
  return h;
}

function startDrag(e: PointerEvent, frame: FrameState, index: number, h: HTMLElement) {
  if (e.button !== 0) return;
  e.preventDefault();
  const li = h.closest('li')!;
  const list = li.parentElement!;
  const scroller = $('panel-content');
  h.setPointerCapture(e.pointerId);
  li.classList.add('dragging');
  const marker = el('div', 'drop-marker');
  list.appendChild(marker);
  let target = index;
  let lastY = e.clientY;
  let raf = 0;

  const place = () => {
    const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > .item'));
    const top = list.getBoundingClientRect().top;
    target = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i].getBoundingClientRect();
      if (lastY < b.top + b.height / 2) { target = i; break; }
    }
    const ref = rows[target];
    const y = ref ? ref.getBoundingClientRect().top - top : rows[rows.length - 1].getBoundingClientRect().bottom - top;
    marker.style.top = `${y - 1}px`;
  };
  const tick = () => {
    const box = scroller.getBoundingClientRect();
    if (lastY < box.top + 40) scroller.scrollTop -= 8;
    else if (lastY > box.bottom - 40) scroller.scrollTop += 8;
    place();
    raf = requestAnimationFrame(tick);
  };
  const move = (ev: PointerEvent) => { lastY = ev.clientY; };
  const end = (ev: PointerEvent) => {
    cancelAnimationFrame(raf);
    h.removeEventListener('pointermove', move);
    h.removeEventListener('pointerup', end);
    h.removeEventListener('pointercancel', end);
    marker.remove();
    li.classList.remove('dragging');
    if (ev.type === 'pointerup') {
      // Visible rows aren't frame.items one-to-one (folded tables, summary rows), so land the item
      // just before the layer whose row it was dropped on, or after the last one.
      const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > .item'));
      const posOf = (r?: HTMLElement) => {
        const id = r?.dataset.nodeId;
        let k = id ? frame.items.findIndex((x) => x.nodeId === id) : -1;
        // A table or list row stands for its first layer.
        if (k < 0 && id) k = frame.items.findIndex((x) => [...tables, ...lists].some((s) => s.id === id && JSON.stringify(s).includes(`"${x.nodeId}"`)));
        return k;
      };
      let before = -1;
      for (let r = target; r < rows.length && before < 0; r++) before = posOf(rows[r]);
      const at = before < 0 ? frame.items.length : before;
      const to = at > index ? at - 1 : at;
      if (to !== index) moveItem(frame, index, to);
    }
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  raf = requestAnimationFrame(tick);
}

function moveItem(frame: FrameState, from: number, to: number) {
  if (to < 0 || to >= frame.items.length || to === from) return;
  remember('Reorder');
  const [item] = frame.items.splice(from, 1);
  frame.items.splice(to, 0, item);
  frame.orderSet = true;
  send({ type: 'set-order', frameId: frame.id, order: frame.items.map((x) => x.nodeId) });
  refreshFrame(frame);
  document.querySelector<HTMLElement>(`.item[data-node-id="${CSS.escape(item.nodeId)}"] .handle`)?.focus();
  announce(`Moved to position ${to + 1} of ${frame.items.length}`);
  renderStatus();
  syncOverlay();
}

function resetOrder(frame: FrameState) {
  remember('Reset order');
  frame.items.sort((a, b) => a.autoIndex - b.autoIndex);
  frame.orderSet = false;
  send({ type: 'set-order', frameId: frame.id, order: [] });
  refreshFrame(frame);
  document.querySelector<HTMLElement>(`.frame[data-frame-id="${CSS.escape(frame.id)}"] summary`)?.focus();
  announce(`${frame.name}: order reset to automatic`);
  renderStatus();
  syncOverlay();
}

// =============================================================================================
// Frames
// =============================================================================================

/** Characters drawn as a pattern (a dot-matrix, ASCII art): hundreds of tiny layers, all skipped. */
const PATTERN = 'Part of a pattern drawn with characters';
const isPattern = (it: ItemState) => it.kind === 'text' && !it.roleSet && it.reason === PATTERN;
const expandedPatterns = new Set<string>();

function patternRow(frame: FrameState, count: number): HTMLElement {
  const li = el('li', 'item pattern');
  const open = expandedPatterns.has(frame.id);
  li.append(el('span'), el('span', 'pattern-badge', 'Skip'));
  const cell = el('div', 'text-cell');
  cell.append(
    el('div', 'pattern-title', `${count.toLocaleString()} characters drawn as a pattern`),
    el('div', 'skip-hint pattern-hint', 'Decorative · screen readers skip them'),
  );
  const toggle = foldButton(open);
  toggle.onclick = () => {
    if (open) expandedPatterns.delete(frame.id); else expandedPatterns.add(frame.id);
    refreshFrame(frame);
  };
  li.append(cell, toggle);
  return li;
}

const expandedStructures = new Set<string>();

/** One row standing for a whole table or list; its layers fold away under it. */
function structureRow(frame: FrameState, s: TableSuggestion | ListSuggestion, count: number): HTMLElement {
  const isTable = 'rows' in s;
  const li = el('li', 'item pattern structure');
  li.dataset.nodeId = s.id;
  const open = expandedStructures.has(s.id);
  li.append(el('span'), el('span', 'pattern-badge structure-badge', isTable ? 'Table' : 'List'));
  const cell = el('div', 'text-cell');
  let title: string;
  let hint: string;
  if (isTable) {
    const heads = [s.headerRow && 'header row', s.headerCol && 'header column'].filter(Boolean).join(' and ');
    title = `${s.rows.length} rows × ${s.rows[0]?.length ?? 0} columns · ${heads}` + (s.caption ? ' · titled' : '');
    hint = 'Read as a table: each cell with its header';
  } else {
    title = `${s.items.length} items` + (s.items.every((e) => e.label) ? ' with labels' : '');
    hint = 'Read as a list: “list, N items”, then each entry';
  }
  cell.append(el('div', 'pattern-title', title), el('div', 'skip-hint pattern-hint', `${hint} · ${count} layers`));
  const actions = el('div', 'structure-actions');
  const toggle = foldButton(open);
  toggle.onclick = () => {
    if (open) expandedStructures.delete(s.id); else expandedStructures.add(s.id);
    refreshFrame(frame);
  };
  const off = el('button', 'link muted', isTable ? 'Not a table' : 'Not a list');
  off.type = 'button';
  off.title = 'Read these layers as separate text instead';
  off.onclick = () => {
    setStructureOff(frame, s.id, true);
    announce(`${isTable ? 'Table' : 'List'} turned off; its layers are read as text`);
  };
  actions.append(toggle, off);
  li.append(cell, actions);
  jumpOnClick(li, () => (isTable ? [...(s.caption ? [s.caption] : []), ...s.rows.flat(2)] : s.items.flatMap((e) => [...(e.label ? [e.label] : []), ...e.body])));
  return li;
}

/** "12 chart labels": the text inside a chart or diagram, folded under it. */
function chartLabelsRow(frame: FrameState, chart: ItemState, count: number): HTMLElement {
  const li = el('li', 'item pattern');
  const open = expandedStructures.has(chart.nodeId);
  const described = isFigure(chart);
  const what = chart.diagram ? 'diagram' : 'chart';
  li.append(el('span'), el('span', 'pattern-badge', described ? 'Skip' : 'Text'));
  const cell = el('div', 'text-cell');
  cell.append(
    el('div', 'pattern-title', `${count} label${count === 1 ? '' : 's'} in this ${what}`),
    el('div', 'skip-hint pattern-hint', described ? `The ${what}’s alt text speaks for them` : `Read as text until the ${what} has alt text`),
  );
  const toggle = foldButton(open);
  toggle.onclick = () => {
    if (open) expandedStructures.delete(chart.nodeId); else expandedStructures.add(chart.nodeId);
    refreshFrame(frame);
  };
  li.append(cell, toggle);
  jumpOnClick(li, () => [chart.nodeId]);
  return li;
}

/** Every copy of this image or graphic in the export: same component, image or layer name. */
function sameObject(item: ItemState): ItemState[] {
  if (item.kind !== 'image' || !item.signature || item.chart || item.diagram) return [item];
  return frames.flatMap((f) => f.items.filter((x) => x.kind === 'image' && x.signature === item.signature));
}

/** On more than one page, and skipped: shown once, folded everywhere else. */
const isRepeatedSkip = (it: ItemState) => it.kind === 'image' && !!it.decorative && sameObject(it).length > 1;

/** "2 repeated graphics, skipped on every page": the logo and rules that show up on each page. */
function repeatsRow(frame: FrameState, items: ItemState[]): HTMLElement {
  const key = `repeats:${frame.id}`;
  const open = expandedStructures.has(key);
  const li = el('li', 'item pattern');
  li.append(el('span'), el('span', 'pattern-badge', 'Skip'));
  const cell = el('div', 'text-cell');
  const names = [...new Set(items.map((i) => i.componentName || i.name))];
  cell.append(
    el('div', 'pattern-title', `${items.length} repeated graphic${items.length === 1 ? '' : 's'} · ${short(names.join(', '), 40)}`),
    el('div', 'skip-hint pattern-hint', 'On every page and decorative · decided once for all pages'),
  );
  const toggle = foldButton(open);
  toggle.onclick = () => {
    if (open) expandedStructures.delete(key); else expandedStructures.add(key);
    refreshFrame(frame);
  };
  li.append(cell, toggle);
  jumpOnClick(li, () => items.map((i) => i.nodeId));
  return li;
}

function renderItems(frame: FrameState): HTMLOListElement {
  const list = el('ol', 'items') as HTMLOListElement;
  // To review: only the rows that need something (or were just settled), flat, in reading order.
  if (view === 'review') {
    list.classList.add('review');
    list.setAttribute('aria-label', `To review on ${frame.name}`);
    frame.items.forEach((it, i) => {
      if (!issuesByNode.has(it.nodeId) && !justFixed.has(it.nodeId)) return;
      list.appendChild(it.kind === 'image' ? imageRow(frame, it, i) : textRow(frame, it, i));
    });
    for (const issue of issuesNow.filter((x) => x.frameId === frame.id && !x.nodeId)) {
      const li = el('li', `item note attention ${issue.level}`);
      li.append(el('span'), el('div', 'attention-note', issue.text));
      list.appendChild(li);
    }
    return list;
  }
  // Everything: rows mark their own issues; folded groups (tables, charts, repeats) mark their summary row.
  list.setAttribute('aria-label', `Reading order for ${frame.name}`);
  const patterns = frame.items.filter(isPattern).length;
  const collapse = patterns >= 20 && !expandedPatterns.has(frame.id);
  let summaryShown = false;

  // Which table or list each layer belongs to; the structure's row goes where its first layer is.
  const owner = new Map<string, TableSuggestion | ListSuggestion>();
  for (const t of tables.filter((t) => t.frameId === frame.id)) for (const id of [...(t.caption ? [t.caption] : []), ...t.rows.flat(2)]) owner.set(id, t);
  for (const l of lists.filter((l) => l.frameId === frame.id))
    for (const e of l.items) for (const id of [...(e.label ? [e.label] : []), ...e.body]) owner.set(id, l);
  const shown = new Set<string>();
  const charts = new Map(frame.items.filter((i) => i.chart || i.diagram).map((c) => [c.nodeId, c]));
  const labelCount = (id: string) => frame.items.filter((i) => i.inChart === id).length;

  const repeats = frame.items.filter(isRepeatedSkip);
  let repeatsShown = false;

  frame.items.forEach((it, i) => {
    if (isRepeatedSkip(it)) {
      if (!repeatsShown) { list.appendChild(repeatsRow(frame, repeats)); repeatsShown = true; }
      if (!expandedStructures.has(`repeats:${frame.id}`)) return;
    }
    if (patterns >= 20 && isPattern(it)) {
      if (!summaryShown) { list.appendChild(patternRow(frame, patterns)); summaryShown = true; }
      if (collapse) return;
    }
    const s = owner.get(it.nodeId);
    if (s && !shown.has(s.id)) {
      shown.add(s.id);
      const row = structureRow(frame, s, [...owner.values()].filter((x) => x === s).length);
      const inside = [...owner.entries()].filter(([, x]) => x === s).flatMap(([id]) => issuesByNode.get(id) ?? []);
      if (inside.length && !expandedStructures.has(s.id)) {
        row.classList.add('attention', 'warn');
        row.querySelector('.text-cell')?.appendChild(el('div', 'attention-note', inside.length === 1 ? inside[0].text : `${inside.length} things inside need a look`));
      }
      list.appendChild(row);
    }
    if (s && !expandedStructures.has(s.id)) return;
    if (it.inChart && charts.has(it.inChart) && !expandedStructures.has(it.inChart)) return;

    const row = it.kind === 'image' ? imageRow(frame, it, i) : textRow(frame, it, i);
    if (s || it.inChart) row.classList.add('in-structure');
    // Layers that sit together in one block on the canvas get a rail, so grouping is visible.
    const prev = frame.items[i - 1]?.group === it.group;
    const next = frame.items[i + 1]?.group === it.group;
    if (prev || next) row.classList.add('in-group');
    if (!prev) row.classList.add('group-first');
    if (!next) row.classList.add('group-last');
    list.appendChild(row);
    if ((it.chart || it.diagram) && labelCount(it.nodeId)) {
      const labelsRow = chartLabelsRow(frame, it, labelCount(it.nodeId));
      const inside = frame.items.filter((x) => x.inChart === it.nodeId).flatMap((x) => issuesByNode.get(x.nodeId) ?? []);
      if (inside.length && !expandedStructures.has(it.nodeId)) {
        labelsRow.classList.add('attention', 'warn');
        labelsRow.querySelector('.text-cell')?.appendChild(el('div', 'attention-note', inside.length === 1 ? inside[0].text : `${inside.length} labels need a look`));
      }
      list.appendChild(labelsRow);
    }
  });
  return list;
}

const isOpen = (id: string) => (view === 'review' ? !closedInReview.has(id) : openFrames.has(id));
function setOpen(id: string, open: boolean) {
  if (view === 'review') { if (open) closedInReview.delete(id); else closedInReview.add(id); }
  else if (open) openFrames.add(id); else openFrames.delete(id);
}
/** A page's rows are only built once it is open — a 20-page file doesn't draw 20 pages of rows. */
function ensureItems(d: HTMLElement, f: FrameState) {
  if (!d.querySelector(':scope > ol.items')) d.appendChild(renderItems(f));
}

function renderFrame(f: FrameState): HTMLElement {
  const mine = issuesNow.filter((i) => i.frameId === f.id);
  // To review: a page with nothing left is one quiet line.
  if (view === 'review' && !mine.length && !f.items.some((i) => justFixed.has(i.nodeId))) {
    const row = el('button', 'frame done-frame');
    row.type = 'button';
    row.dataset.frameId = f.id;
    const mark = el('span', 'done-mark');
    mark.appendChild(icon('check', 14));
    row.append(mark, el('span', 'done-name', f.name));
    row.title = 'Nothing to review on this page. Click to show it on the canvas.';
    row.setAttribute('aria-label', `${f.name}: nothing to review. Show on canvas.`);
    row.onclick = () => send({ type: 'select', nodeIds: [f.id] });
    return row;
  }
  const d = el('details', 'frame') as HTMLDetailsElement;
  d.dataset.frameId = f.id;
  d.open = isOpen(f.id);
  if (f.id === currentFrameId) d.classList.add('here');
  const s = el('summary');
  const badge = el('span', 'badge ' + (!mine.length ? 'ok' : mine.some((i) => i.level === 'error') ? 'error' : 'warn'), mine.length ? String(mine.length) : '');
  if (!mine.length) badge.appendChild(icon('check', 12));
  badge.title = mine.length ? `${mine.length} to review` : 'Nothing to review on this page';
  s.append(icon('chevron-right', 12, 'caret'), el('span', undefined, f.name), el('span', 'count', String(f.items.length)), badge);
  d.appendChild(s);
  if (view === 'all') {
    const offCount = f.structuresOff?.length ?? 0;
    if (offCount) {
      const note = el('div', 'order-note', `${offCount} table${offCount === 1 ? '' : 's'} or list${offCount === 1 ? '' : 's'} read as text · `);
      const restore = el('button', 'link', 'Restore');
      restore.type = 'button';
      restore.onclick = () => {
        for (const id of [...(f.structuresOff ?? [])]) setStructureOff(f, id, false);
        announce('Tables and lists restored');
      };
      note.appendChild(restore);
      d.appendChild(note);
    }
    if (f.orderSet) {
      const note = el('div', 'order-note', 'Custom order · ');
      const reset = el('button', 'link', 'Reset to automatic');
      reset.type = 'button';
      reset.onclick = () => resetOrder(f);
      note.appendChild(reset);
      d.appendChild(note);
    }
  }
  if (d.open) d.appendChild(renderItems(f));
  d.addEventListener('toggle', () => {
    setOpen(f.id, d.open);
    if (d.open) ensureItems(d, f);
  });
  return d;
}

/**
 * Re-rendering replaces rows, which would drop keyboard focus (and a caret mid-word). Remember
 * which row and control had focus, and put it back on the new one.
 */
const FOCUSABLE = ['.alt', '.role', '.handle', '.text', '.link', '.fix-btn', '.check input', '.done-frame', 'summary'];
function keepFocus(render: () => void) {
  const active = document.activeElement as HTMLElement | null;
  const row = active?.closest<HTMLElement>('[data-node-id]');
  const frame = active?.closest<HTMLElement>('.frame');
  const control = active ? FOCUSABLE.find((c) => active.matches(c)) : undefined;
  const label = active?.textContent ?? '';
  const caret = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] as const : null;
  render();
  if (!active || document.contains(active) || !control) return;
  const scope = row?.dataset.nodeId
    ? document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(row.dataset.nodeId)}"]`)
    : frame?.dataset.frameId ? document.querySelector<HTMLElement>(`.frame[data-frame-id="${CSS.escape(frame.dataset.frameId)}"]`) : null;
  if (!scope) return;
  const candidates = [...(scope.matches(control) ? [scope] : []), ...Array.from(scope.querySelectorAll<HTMLElement>(control))];
  // The same control if it's still there; otherwise the row's first control, so focus isn't lost.
  const next = candidates.find((c) => c.textContent === label) ?? candidates[0]
    ?? (scope.matches('button') ? scope : scope.querySelector<HTMLElement>('select, textarea, button, input, summary'));
  next?.focus({ preventScroll: true });
  if (caret && next instanceof HTMLTextAreaElement) next.setSelectionRange(caret[0], caret[1]);
}

function refreshFrame(frame: FrameState) {
  const old = document.querySelector<HTMLElement>(`.frame[data-frame-id="${CSS.escape(frame.id)}"]`);
  if (!old) return;
  refreshIssues();
  keepFocus(() => old.replaceWith(renderFrame(frame)));
}

function renderFrames() {
  keepFocus(renderFramesNow);
}

function renderFramesNow() {
  const root = $('frames');
  refreshIssues();
  root.textContent = '';
  root.classList.toggle('review-view', view === 'review');
  $('legend').hidden = !frames.length;
  $('hints').hidden = !frames.length || view !== 'all';
  if (!frames.length) {
    const empty = el('div', 'empty');
    empty.append(el('strong', undefined, 'No frames here yet'), el('span', undefined, 'Select one or more top-level frames on the canvas.'));
    const b = el('button', 'link', 'Use selection');
    b.type = 'button';
    b.onclick = () => send({ type: 'refresh' });
    empty.appendChild(b);
    root.appendChild(empty);
    return;
  }
  if (view === 'review' && !issuesNow.length && !justFixed.size) {
    const done = el('div', 'all-done');
    done.append(el('strong', undefined, 'Nothing left to review'), el('span', undefined, 'Export when you’re ready, or look through every layer.'));
    const b = el('button', 'link', 'Show everything');
    b.type = 'button';
    b.onclick = () => setView('all');
    done.appendChild(b);
    root.appendChild(done);
  }
  for (const f of frames) root.appendChild(renderFrame(f));
}

// =============================================================================================
// Preview: what a screen reader will say, and the heading outline — from the export's own items.
// =============================================================================================

let previewMode: 'read' | 'outline' = 'read';

function previewPages(): PreviewPage[] {
  return frames.map((f) => {
    const mine = <T extends { frameId: string }>(xs: T[]) => xs.filter((x) => x.frameId === f.id);
    return { name: f.name, frameId: f.id, items: toItems(f, mine(tables), mine(lists)) };
  });
}

function renderPreview() {
  const host = $('preview-body');
  host.textContent = '';
  $('preview-read').setAttribute('aria-pressed', String(previewMode === 'read'));
  $('preview-outline').setAttribute('aria-pressed', String(previewMode === 'outline'));
  if (!frames.length) return;
  const pages = previewPages();
  const goTo = (frameId: string, nodeId?: string) => () => {
    if (nodeId) send({ type: 'select', nodeIds: [nodeId], exact: true });
    else send({ type: 'select', nodeIds: [frameId] });
  };
  if (previewMode === 'outline') {
    const ol = outline(pages);
    if (!ol.length) { host.appendChild(el('div', 'preview-empty', 'No headings yet.')); return; }
    const list = el('ol', 'outline');
    for (const h of ol) {
      const li = el('li', 'outline-item' + (h.skipped ? ' skipped-level' : ''));
      li.style.paddingLeft = `${(h.level - 1) * 14 + 8}px`;
      const b = el('button', 'preview-line');
      b.type = 'button';
      b.append(el('span', 'lvl', `H${h.level}`), el('span', 'preview-text', h.text));
      if (h.skipped) b.appendChild(el('span', 'skip-flag', 'skips a level'));
      b.title = `${h.page} — click to show it on the canvas`;
      b.onclick = goTo(h.frameId, h.nodeId);
      li.appendChild(b);
      list.appendChild(li);
    }
    host.appendChild(list);
    return;
  }
  for (const p of pages) {
    const section = el('section', 'preview-page');
    const h = el('button', 'preview-page-name', p.name);
    h.type = 'button';
    h.onclick = goTo(p.frameId);
    section.appendChild(h);
    const lines = transcript(p);
    const list = el('ol', 'read-aloud');
    if (!lines.length) list.appendChild(el('li', 'preview-empty', 'Nothing is read on this page.'));
    for (const line of lines) {
      const li = el('li', `line ${line.kind}`);
      const b = el('button', 'preview-line');
      b.type = 'button';
      const said = spoken(line);
      const cut = said.indexOf(', ');
      if (line.kind === 'heading' || line.kind === 'image' || line.kind === 'table' || line.kind === 'list') {
        b.append(el('span', 'said-kind', said.slice(0, cut)), el('span', 'preview-text', said.slice(cut + 2)));
      } else {
        b.appendChild(el('span', 'preview-text', said));
      }
      b.onclick = goTo(p.frameId, line.nodeId);
      li.appendChild(b);
      list.appendChild(li);
    }
    section.appendChild(list);
    host.appendChild(section);
  }
}
$('preview-read').addEventListener('click', () => { previewMode = 'read'; renderPreview(); });
$('preview-outline').addEventListener('click', () => { previewMode = 'outline'; renderPreview(); });

// =============================================================================================
// Settings
// =============================================================================================

function suggestedTitle(): string {
  for (const f of frames) for (const it of f.items) if (it.kind === 'text' && it.role === 'H1') return clean(it.text);
  return fileName;
}

function syncTitlePlaceholder() {
  $<HTMLInputElement>('title').placeholder = suggestedTitle() || 'Document title';
}

/** What a designer calls a text style: its Figma style name, or how it looks. */
function styleLabel(it: ItemState): string {
  if (it.styleName) return it.styleName;
  return `${it.fontFamily ?? 'Text'} ${(it.fontWeight ?? 400) >= 600 ? 'Bold ' : ''}${it.italic ? 'Italic ' : ''}${Math.round(it.fontSize ?? 0)}`;
}

/** Review → Options → Text styles: one rule per style, applied to every layer in it that isn't set by hand. */
function renderStyleRules() {
  const host = $('style-rules');
  host.textContent = '';
  const styles = new Map<string, { count: number; size: number; sample: string; roles: Map<string, number> }>();
  for (const f of [...frames, ...context])
    for (const it of f.items) {
      if (it.kind !== 'text') continue;
      const key = styleLabel(it);
      const st = styles.get(key) ?? { count: 0, size: it.fontSize ?? 0, sample: clean(it.text), roles: new Map() };
      st.count++;
      if (!it.roleSet && !it.ruled && it.role) st.roles.set(it.role, (st.roles.get(it.role) ?? 0) + 1);
      styles.set(key, st);
    }
  const sorted = [...styles.entries()].sort((a, b) => b[1].size - a[1].size || b[1].count - a[1].count);
  for (const [key, st] of sorted) {
    const row = el('div', 'style-rule');
    const id = `rule-${key.replace(/[^\w-]+/g, '-')}`;
    const info = el('label', 'style-info');
    info.htmlFor = id;
    info.append(el('span', 'style-name', key), el('span', 'style-sample', `${st.count} × · ${short(st.sample, 34)}`));
    const sel = el('select', 'role') as HTMLSelectElement;
    sel.id = id;
    const usual = [...st.roles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as TextRole | undefined;
    sel.appendChild(Object.assign(el('option', undefined, usual ? `Auto (${ROLE_LABEL[usual] ?? usual})` : 'Auto'), { value: '' }));
    for (const r of ROLES) sel.appendChild(Object.assign(el('option', undefined, ROLE_LABEL[r] ?? r), { value: r }));
    sel.value = doc.styleRoles?.[key] ?? '';
    sel.classList.toggle('suggested', !sel.value);
    sel.onchange = () => {
      remember(`Rule for “${key}”`);
      const rules = { ...(doc.styleRoles ?? {}) };
      if (sel.value) rules[key] = sel.value as TextRole; else delete rules[key];
      doc.styleRoles = rules;
      saveDoc();
      applySuggestions();
      renderFrames();
      refreshSummary();
      renderStyleRules();
      announce(sel.value ? `Every “${key}” layer is now ${ROLE_LABEL[sel.value as TextRole] ?? sel.value}` : `“${key}” back to automatic`);
    };
    row.append(info, sel);
    host.appendChild(row);
  }
}

/** Export → Pages: which frames go in the PDF, and in what order. */
function renderPages() {
  const host = $('pages-list');
  host.textContent = '';
  const save = (list: typeof pagesList, focusId?: string, control: 'box' | 'up' | 'down' = 'box') => {
    send({ type: 'set-pages', order: list.map((p) => p.id), skip: list.filter((p) => p.skip).map((p) => p.id) });
    pagesList = list;
    renderPages();
    // Put focus back on the same page's control (the other arrow, if this one is now disabled).
    const row = focusId ? host.querySelector<HTMLElement>(`.page-row[data-id="${CSS.escape(focusId)}"]`) : null;
    const want = row?.querySelector<HTMLElement>(control === 'box' ? 'input' : control === 'up' ? '.page-move.up' : '.page-move.down');
    const other = row?.querySelector<HTMLElement>(control === 'up' ? '.page-move.down' : '.page-move.up');
    ((want && !(want as HTMLButtonElement).disabled ? want : other ?? row?.querySelector('input')) as HTMLElement | null)?.focus();
  };
  pagesList.forEach((p, k) => {
    const row = el('div', 'page-row' + (p.skip ? ' left-out' : ''));
    row.dataset.id = p.id;
    const box = el('input') as HTMLInputElement;
    box.type = 'checkbox';
    box.checked = !p.skip;
    box.id = `page-${k}`;
    box.onchange = () => save(pagesList.map((x) => (x.id === p.id ? { ...x, skip: !box.checked } : x)), p.id, 'box');
    const name = el('label', 'page-name', p.name);
    name.htmlFor = box.id;
    const move = (d: number) => () => {
      const list = [...pagesList];
      const [it] = list.splice(k, 1);
      list.splice(k + d, 0, it);
      save(list, p.id, d < 0 ? 'up' : 'down');
      announce(`${p.name} moved to position ${k + d + 1}`);
    };
    const up = el('button', 'page-move up');
    up.appendChild(icon('arrow-up', 12));
    up.type = 'button';
    up.disabled = k === 0;
    up.setAttribute('aria-label', `Move ${p.name} up`);
    up.onclick = move(-1);
    const down = el('button', 'page-move down');
    down.appendChild(icon('arrow-down', 12));
    down.type = 'button';
    down.disabled = k === pagesList.length - 1;
    down.setAttribute('aria-label', `Move ${p.name} down`);
    down.onclick = move(1);
    row.append(box, name, up, down);
    host.appendChild(row);
  });
  const left = pagesList.filter((p) => p.skip).length;
  $('pages-note').textContent = pagesList.length ? `${pagesList.length - left} of ${pagesList.length} pages in the export${left ? ` · ${left} left out` : ''}` : '';
}

function renderSettings() {
  renderStyleRules();
  renderPages();
  $<HTMLInputElement>('flag-contrast').checked = !doc.acceptContrast;
  $<HTMLInputElement>('title').value = doc.title;
  $<HTMLInputElement>('language').value = doc.language;
  $<HTMLSelectElement>('color-profile').value = doc.colorProfile;
  const box = $('quality');
  box.textContent = '';
  for (const [key, p] of Object.entries(PRESETS) as Array<[QualityPreset, (typeof PRESETS)[QualityPreset]]>) {
    const label = el('label', 'choice');
    const radio = el('input') as HTMLInputElement;
    radio.type = 'radio';
    radio.name = 'quality';
    radio.value = key;
    radio.checked = doc.quality === key;
    radio.onchange = () => saveDoc();
    label.append(radio, el('strong', undefined, p.label), el('span', undefined, p.detail));
    box.appendChild(label);
  }
  syncExportMeta();
}

let previousLanguage = 'en-US';
function saveDoc() {
  const quality = (document.querySelector<HTMLInputElement>('input[name="quality"]:checked')?.value ?? 'original') as QualityPreset;
  doc = {
    title: clean($<HTMLInputElement>('title').value),
    language: clean($<HTMLInputElement>('language').value) || 'en-US',
    quality,
    colorProfile: $<HTMLSelectElement>('color-profile').value as ColorProfile,
    styleRoles: doc.styleRoles ?? {},
    acceptContrast: $<HTMLInputElement>('flag-contrast').checked ? false : true,
    dismissed: doc.dismissed ?? [],
  };
  send({ type: 'set-doc', doc });
  // Another document language changes which passages count as "another language".
  if (baseLang(doc.language) !== baseLang(previousLanguage)) {
    previousLanguage = doc.language;
    detectLanguages();
    changed();
  }
  syncExportMeta();
}

function syncExportMeta() {
  const n = frames.length;
  const color: Record<string, string> = { DOCUMENT: 'file colors', SRGB: 'sRGB', DISPLAY_P3_V4: 'Display P3' };
  const profile = $<HTMLSelectElement>('color-profile').value;
  $('export-meta').textContent = n
    ? `${n} page${n === 1 ? '' : 's'} · ${PRESETS[doc.quality].label} quality · ${color[profile] ?? profile}`
    : '';
}

// =============================================================================================
// Export
// =============================================================================================

/** JPEG resize and re-encode through the browser: createImageBitmap + canvas. */
const canvasCodec: ImageCodec = {
  async jpeg(bytes, width, height, quality) {
    // colorSpaceConversion 'none' keeps the pixel values as-is; the PDF's own color space
    // (often an embedded ICC profile) still describes them.
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
      colorSpaceConversion: 'none', resizeWidth: width, resizeHeight: height, resizeQuality: 'high',
    });
    const canvas = el('canvas') as HTMLCanvasElement;
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('JPEG encode failed'))), 'image/jpeg', quality));
    return new Uint8Array(await blob.arrayBuffer());
  },
};

function download(bytes: Uint8Array, name: string) {
  downloadFile(bytes, name, 'application/pdf');
}

function downloadFile(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = el('a') as HTMLAnchorElement;
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// =============================================================================================
// Progress: a bar under the tabs while reading frames, and the export button filling as it goes.
// =============================================================================================

/** Lets the browser paint before the next chunk of work (rAF can stall in a hidden panel). */
const paint = () =>
  new Promise<void>((resolve) => {
    let fired = false;
    const go = () => { if (!fired) { fired = true; setTimeout(resolve, 0); } };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });

let reading = false;
function setReading(done: number | null, total = 0) {
  const bar = $('loadbar');
  const fill = bar.firstElementChild as HTMLElement;
  if (done === null) {
    reading = false;
    bar.hidden = true;
    $('loading').hidden = true;
    $('frames').classList.remove('dimmed');
    return;
  }
  reading = true;
  bar.hidden = false;
  const known = total > 0;
  bar.classList.toggle('indeterminate', !known);
  fill.style.width = known ? `${Math.max(4, (done / total) * 100)}%` : '';
  bar.setAttribute('aria-valuenow', known ? String(Math.round((done / total) * 100)) : '');
  const detail = known ? `Frame ${Math.min(done + 1, total)} of ${total}` : 'Looking at text, images and layout';
  // First read: a centered loading state. Re-reads: keep the list, dim it, show progress up top.
  if (!frames.length) {
    $('loading').hidden = false;
    $('loading-detail').textContent = detail;
  } else {
    $('frames').classList.add('dimmed');
    $('source').textContent = `Reading frames · ${detail.toLowerCase()}`;
  }
}

let lastPhase = '';
let exporting = false;
/** After the first export the button says "Export again"; results stay above it. */
let exportedOnce = false;
/** label null = idle. fraction 0–1 fills the button; the phase is announced once to screen readers. */
function busy(label: string | null, fraction = 0, phase = '') {
  const b = $<HTMLButtonElement>('export');
  const fill = b.querySelector<HTMLElement>('.fill')!;
  const text = b.querySelector<HTMLElement>('.label')!;
  const working = label !== null;
  b.disabled = working || frames.length === 0;
  b.classList.toggle('working', working);
  text.textContent = label ?? (exportedOnce ? 'Export again' : 'Export PDF');
  fill.style.width = working ? `${Math.round(fraction * 100)}%` : '0';
  $('export-progress').setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  if (phase && phase !== lastPhase) $('progress-live').textContent = phase;
  lastPhase = working ? phase : '';
}

/** Share of the export bar each stage gets. Compression only takes a share when it runs. */
function stages() {
  const compress = doc.quality === 'original' ? 0 : 0.15;
  return { export: 0.4, tag: 0.5 - compress, compress, save: 0.1 };
}

function result(lines: Array<[string, '' | 'ok' | 'warn' | 'err' | 'meta']>) {
  const r = $('result');
  r.textContent = '';
  for (const [text, kind] of lines) r.appendChild(el('div', kind || undefined, text));
}

async function onExported(msg: Extract<ToUI, { type: 'exported' }>) {
  const w = stages();
  busy('Tagging…', w.export, 'Tagging pages');
  await paint();
  const title = doc.title || suggestedTitle() || 'Untitled';
  // Use what is on screen, not the sandbox's read-back: the last edit may still be in flight.
  const input: DocumentInput = {
    title,
    language: doc.language || 'en-US',
    pages: msg.pages.map(({ frame, pdf }) => {
      const onScreen = frames.find((f) => f.id === frame.id) ?? frame;
      const mine = <T extends { frameId: string }>(xs: T[]) => xs.filter((x) => x.frameId === onScreen.id);
      return { pdf, name: onScreen.name, items: toItems(onScreen, mine(tables), mine(lists)) };
    }),
  };
  const { pdf, report } = await buildTaggedPdf(input, {
    quality: doc.quality,
    codec: canvasCodec,
    onProgress: async ({ phase, done, total }) => {
      if (phase === 'tag') busy(`Tagging page ${done + 1} of ${total}…`, w.export + w.tag * (done / total), 'Tagging pages');
      else if (phase === 'compress') busy(`Compressing image ${done + 1} of ${total}…`, w.export + w.tag + w.compress * (done / Math.max(1, total)), 'Compressing images');
      else busy('Saving…', w.export + w.tag + w.compress, 'Saving');
      await paint();
    },
  });
  busy('Done', 1, 'Done');
  await paint();

  const lines: Array<[string, '' | 'ok' | 'warn' | 'err' | 'meta']> = [];
  const safe = title.replace(/[^\w\- ]+/g, '').trim() || 'document';
  lines.push([`✓ Saved “${safe}.pdf” · ${mb(pdf.length)}`, 'ok']);
  const shrunk = report.images.filter((i) => !i.kept);
  if (shrunk.length) {
    const before = shrunk.reduce((s, i) => s + i.before, 0);
    const after = shrunk.reduce((s, i) => s + i.after, 0);
    lines.push([`Images ${mb(before)} → ${mb(after)} (${shrunk.length} compressed)`, 'meta']);
  }
  if (report.vectors && report.vectors.after < report.vectors.before)
    lines.push([`Vector art ${mb(report.vectors.before)} → ${mb(report.vectors.after)}`, 'meta']);
  const sum = (k: 'tables' | 'lists' | 'links') => report.pages.reduce((n, p) => n + p[k], 0);
  const extras = [
    [sum('tables'), 'table'], [sum('lists'), 'list'], [sum('links'), 'link'], [report.bookmarks, 'bookmark'],
  ].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`);
  if (extras.length) lines.push([`Tagged ${extras.join(' · ')}`, 'meta']);
  for (const p of report.pages) {
    if (p.unmatched.length) lines.push([`${p.name}: ${p.unmatched.length} text layer(s) weren't found in Figma's PDF`, 'warn']);
    if (p.defaulted.length) lines.push([`${p.name}: ${p.defaulted.length} extra text run(s) added as Text at the end`, 'warn']);
  }
  for (const w of report.warnings) lines.push([w, 'warn']);
  download(pdf, `${safe}.pdf`);
  result(lines);
  // A one-page report to keep with the PDF: what's in it, what was decided, what's still open.
  const reportBtn = el('button', 'link report-link with-icon');
  reportBtn.append(icon('download', 14), 'Download accessibility report');
  reportBtn.type = 'button';
  reportBtn.onclick = () => {
    const decisions = [
      ...(doc.acceptContrast ? ['Low contrast accepted as a design choice (WCAG 1.4.3 not met for those texts)'] : []),
      ...frames.flatMap((f) => (f.structuresOff?.length ? [`${f.name}: ${f.structuresOff.length} detected table/list read as plain text`] : [])),
      ...(doc.dismissed?.length ? [`${doc.dismissed.length} soft warning${doc.dismissed.length === 1 ? '' : 's'} (alt text, link wording, citations) kept as is`] : []),
      ...(Object.keys(doc.styleRoles ?? {}).length ? [`Text style rules: ${Object.entries(doc.styleRoles).map(([k, v]) => `${k} → ${ROLE_LABEL[v] ?? v}`).join(', ')}`] : []),
    ];
    const html = reportHtml({
      title, language: doc.language || 'en-US', fileName, pages: previewPages(),
      openIssues: findIssues().map((i) => ({ page: frames.find((f) => f.id === i.frameId)?.name ?? '', text: i.text })),
      decisions, quality: PRESETS[doc.quality].label, sizeBytes: pdf.length,
      figuresTagged: report.pages.reduce((n, p) => n + p.figures, 0),
      exportWarnings: lines.filter(([, kind]) => kind === 'warn').map(([w]) => w),
    });
    downloadFile(new TextEncoder().encode(html), `${safe} – accessibility report.html`, 'text/html');
  };
  $('result').appendChild(reportBtn);
  exporting = false;
  exportedOnce = true;
  busy(null);
}

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as ToUI | undefined;
  if (!msg) return;
  switch (msg.type) {
    case 'state':
      setReading(null);
      const previousIds = frames.map((f) => f.id).join();
      frames = msg.frames;
      context = msg.context ?? [];
      doc = { ...msg.doc, styleRoles: msg.doc.styleRoles ?? {} };
      previousLanguage = doc.language;
      fileName = msg.fileName;
      source = msg.source;
      // Different frames: the review starts over (same frames, re-read: keep your place).
      if (msg.frames.map((f) => f.id).join() !== previousIds) { reviewKey = ''; reviewIndex = -1; reviewFixed = false; }
      pagesList = msg.pages ?? frames.map((f) => ({ id: f.id, name: f.name, skip: false }));
      // A fresh read: progress and "just done" marks start over.
      issuesByNode = new Map();
      justFixed.clear();
      seenIssues.clear();
      resolvedIssues.clear();
      if (!frames.some((f) => f.id === currentFrameId)) currentFrameId = '';
      applySuggestions();
      if (view === 'all' && !frames.some((f) => openFrames.has(f.id)) && frames[0]) openFrames.add(currentFrameId || frames[0].id);
      $('source').textContent = frames.length
        ? `${frames.length} frame${frames.length === 1 ? '' : 's'} from ${source === 'selection' ? 'your selection' : 'this page'}`
        : '';
      renderFrames();
      refreshSummary();
      renderSettings();
      checkAllContrast();
      if (!exporting) busy(null); // a re-read mid-export must not reset the progress
      return;
    case 'canvas-selection': {
      // You clicked something on the canvas: show that page here, and that layer's row if it has one.
      const f = frames.find((x) => x.id === msg.frameId);
      if (!f) return;
      const moved = currentFrameId !== f.id;
      currentFrameId = f.id;
      if (view === 'all' && moved) { openFrames.clear(); openFrames.add(f.id); }
      if (moved) renderFrames();
      const node = msg.nodeIds.find((id) => f.items.some((i) => i.nodeId === id));
      reveal(f.id, node, true, false);
      return;
    }
    case 'rendered':
      renders.get(msg.frameId)?.(msg.png);
      renders.delete(msg.frameId);
      return;
    case 'reading':
      setReading(msg.done, msg.total);
      return;
    case 'ready':
      readyInfo = msg;
      syncAutoRead(msg.autoRead);
      if (document.body.dataset.stage === 'boot') setStage(msg.autoRead ? 'work' : 'start');
      renderStart();
      return;
    case 'progress': {
      const w = stages();
      busy(
        msg.done < msg.total ? `Exporting frame ${msg.done + 1} of ${msg.total}…` : 'Preparing…',
        w.export * (msg.done / Math.max(1, msg.total)),
        'Exporting frames from Figma',
      );
      return;
    }
    case 'exported':
      onExported(msg).catch((e) => {
        result([[e instanceof Error ? e.message : String(e), 'err']]);
        exporting = false;
        busy(null);
      });
      return;
    case 'error':
      result([[msg.message, 'err']]);
      exporting = false;
      setReading(null);
      busy(null);
      return;
  }
};

$('title').addEventListener('change', saveDoc);
$('flag-contrast').addEventListener('change', () => setAcceptContrast(!$<HTMLInputElement>('flag-contrast').checked));
$('language').addEventListener('change', saveDoc);
$('color-profile').addEventListener('change', saveDoc);
$('refresh').addEventListener('click', () => send({ type: 'refresh' }));
$('reread').addEventListener('click', () => send({ type: 'refresh', keep: true }));
syncUndo();
$('about-site').addEventListener('click', () => send({ type: 'open-url', url: 'https://specterops.io' }));
hydrateIcons();
$('start-go').addEventListener('click', () => {
  setStage('work');
  selectTab('content', true);
  send({ type: 'refresh' });
});
for (const id of ['start-auto', 'auto-read'])
  $(id).addEventListener('change', (e) => setAutoRead((e.target as HTMLInputElement).checked));
$('about-start').addEventListener('click', () => {
  setStage('start');
  send({ type: 'show-start' });
  $('start-go').focus();
});
$('reset-suggestions').addEventListener('click', resetSuggestions);
$('export').addEventListener('click', () => {
  // Persist alt text still being typed; suggestions stay suggestions.
  for (const f of frames)
    for (const it of f.items)
      if (it.kind === 'image' && it.decided) send({ type: 'set-alt', nodeId: it.nodeId, alt: it.alt ?? '' });
  saveDoc();
  result([]);
  exporting = true;
  busy('Starting…', 0, 'Exporting frames from Figma');
  send({ type: 'export' });
});

// Until the first frames arrive, the panel shows its loading state (in the HTML) and a moving bar.
setReading(0, 0);
