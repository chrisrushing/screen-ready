/**
 * Content checks that no PDF validator makes, but people who rely on assistive tech notice:
 * alt text that says nothing useful, links that say "click here", citations that don't lead
 * anywhere, and passages in another language read with the wrong voice.
 *
 * Pure functions over text, so they run in the panel and in tests alike.
 */

// =============================================================================================
// Alt text
// =============================================================================================

export interface AltProblem {
  /** What's wrong, in a few words, for the row. */
  text: string;
  /** A better alt text, when the fix is mechanical (dropping "Image of"). */
  fixed?: string;
}

/** Screen readers already say "image" — leading with it is noise. */
const REDUNDANT_LEAD = /^\s*(an?\s+)?(image|picture|photo(graph)?|graphic|illustration|icon|screenshot|pic)\s+(of|showing|shows|that shows|depicting|with)\s+/i;
const FILE_NAME = /^[\w\s().-]*\.(jpe?g|png|gif|webp|svg|heic|tiff?|pdf)$/i;
const CAMERA_NAME = /^(img|dsc|dcim|pxl|screen ?shot|untitled|image|photo|frame|rectangle|group|vector|ellipse)(?:[\s_-]*\d+)?$/i;
const PLACEHOLDER = /^(alt|alt text|image|picture|photo|graphic|logo|icon|todo|tbd|xxx+|placeholder|lorem ipsum.*)\.?$/i;

/**
 * Problems with one alt text. Charts may run long (they carry data); everything else should be
 * a sentence or two.
 */
export function checkAlt(alt: string, opts: { chart?: boolean; logo?: boolean; nearbyText?: string[] } = {}): AltProblem[] {
  const a = alt.replace(/\s+/g, ' ').trim();
  if (!a) return [];
  const out: AltProblem[] = [];
  if (PLACEHOLDER.test(a)) return [{ text: 'Alt text is a placeholder — say what the image shows' }];
  if (FILE_NAME.test(a) || CAMERA_NAME.test(a)) return [{ text: 'Alt text looks like a file or layer name — say what the image shows' }];
  // A component folder left in ("wf/ · Acme logo"): the folder is read out as is.
  // Only a folder followed by a gap or separator: "Before/after photo" is words, not a path.
  const path = /^(?:[\w-]+\/)+(?=[\s·•|:—–-])\s*[·•|:—–-]?\s*/.exec(a);
  if (path && !/^https?:/i.test(a) && a.length > path[0].length) {
    const rest = a.slice(path[0].length);
    out.push({ text: `Starts with a layer folder (“${path[0].trim()}”) — a screen reader would read it out`, fixed: rest.charAt(0).toUpperCase() + rest.slice(1) });
  }
  if (REDUNDANT_LEAD.test(a)) {
    const rest = a.replace(REDUNDANT_LEAD, '');
    out.push({ text: 'Starts with “image of…” — screen readers already say it’s an image', fixed: rest.charAt(0).toUpperCase() + rest.slice(1) });
  }
  const limit = opts.chart ? 400 : 250;
  if (a.length > limit) out.push({ text: `Alt text is long (${a.length} characters) — keep it to what matters; put details in the page text` });
  const same = (opts.nearbyText ?? []).find((t) => t.replace(/\s+/g, ' ').trim().toLowerCase() === a.toLowerCase());
  if (same && !opts.logo) out.push({ text: 'Alt text repeats the text next to it — a screen reader would hear it twice' });
  return out;
}

// =============================================================================================
// Links
// =============================================================================================

export interface LinkProblem { text: string }

const VAGUE_LINK = /^(click here|here|this|this link|link|more|read more|learn more|see more|find out more|details|more info(rmation)?|go|continue|download|view|website)[\s.!…→»›>]*$/i;
const BARE_URL = /^(https?:\/\/|www\.)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i;

/**
 * A link's words have to make sense on their own: screen reader users jump from link to link and
 * hear only the link text. "Click here" says nothing; a long raw URL is read out character by
 * character.
 */
export function checkLinkText(linkText: string, layerText = linkText): LinkProblem | null {
  const t = linkText.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (VAGUE_LINK.test(t)) return { text: `Link says “${t}” — make the link words say where it goes` };
  // A web address in a source line or a reference ("See the Example Data Hub:
  // example.org/data-hub") is fine: the words around it say where it goes (WCAG 2.4.4, link purpose in
  // context), and print readers need the address. Only an address standing alone is worth a word.
  if (BARE_URL.test(t) && t.length > 30) {
    const around = layerText.replace(linkText, ' ').replace(/\s+/g, ' ').trim();
    if (around.split(' ').filter((w) => /\p{L}{2}/u.test(w)).length >= 3) return null;
    return { text: 'A web address on its own — add a few words beside it that say where it goes (the page or study’s name)' };
  }
  return null;
}

/**
 * What a link is called when a screen reader lists or tabs through links (the annotation's
 * /Contents): a web address in words — "example.org/annual-report-2026" → "example.org: annual
 * report 2026" — and any other link text as it is. The text on the page is left alone.
 */
export function linkDescription(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!BARE_URL.test(t)) return t;
  const bare = t.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const [host, ...path] = bare.split('/');
  const pdf = /\.pdf$/i.test(path[path.length - 1] ?? '');
  const words = path.map((p) => decodeURIComponentSafe(p).replace(/\.(html?|php|aspx?|pdf)$/i, '').replace(/[_+]+|(?<!\d)-+(?!\d)/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return (words.length ? `${host}: ${words.join(', ')}` : host) + (pdf ? ' (PDF)' : '');
}
function decodeURIComponentSafe(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// =============================================================================================
// Citations
// =============================================================================================

export interface Citation {
  /** The marker as written, e.g. "[2]". */
  marker: string;
  /** Its number. */
  n: number;
  /** Where it is in the text (character offsets), for linking that range. */
  start: number;
  end: number;
}

/** Citation markers in body text: "[2]", "[ 12 ]", "[3, 4]", "[3–5]", "[1; 2]". Not code like array[1]. */
export function findCitations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(/\[\s*(\d{1,3}(?:\s*[,;–—−-]\s*\d{1,3})*)\s*\]/g)) {
    const start = m.index ?? 0;
    // Glued to a word or another bracket, it's an index (x[12]), not a citation.
    if (start > 0 && /[\p{L}\p{N}_\])]/u.test(text[start - 1])) continue;
    // One marker, one link target: a group like [3, 4] links to its first source.
    const n = Number(m[1].split(/[,;–—−-]/)[0]);
    if (n > 0 && n < 500) out.push({ marker: m[0], n, start, end: start + m[0].length });
  }
  return out;
}

export interface SourceEntry { n: number; url: string; text: string; nodeId: string }

const URL_IN_TEXT = /\b((?:https?:\/\/|www\.)[^\s\]]+|(?:[a-z0-9-]+\.)+(?:com|org|gov|edu|net|io|ai|co|us|uk|de|eu|int|info)\b(?:\/[^\s\]]*)?)/gi;

/** The first web address in a passage, without the sentence's punctuation. Not an email's domain. */
export function urlIn(text: string): string | undefined {
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const at = m.index ?? 0;
    if (at > 0 && /[@\w.-]/.test(text[at - 1])) continue;
    let url = m[1];
    for (let prev = ''; prev !== url; ) {
      prev = url;
      url = url.replace(/[’']s$/, '').replace(/[.,;:!?"'”’…»]+$/, '');
      // A closing paren belongs to the address only when it opened one (Foo_(bar)).
      if (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1);
    }
    if (url) return url;
  }
  return undefined;
}

/**
 * Numbered entries on a sources page: "2. Omdia survey… https://…", "[2] …", "2 …". Only entries
 * with a web address count — that's where a citation can lead.
 */
export function findSources(items: Array<{ nodeId: string; text: string }>): Map<number, SourceEntry> {
  const out = new Map<number, SourceEntry>();
  const add = (n: number, text: string, nodeId: string) => {
    const url = urlIn(text);
    if (url && !out.has(n)) out.set(n, { n, url: /^https?:\/\//i.test(url) ? url : `https://${url}`, text, nodeId });
  };
  const clean = (k: number) => items[k].text.replace(/\s+/g, ' ').trim();
  const bare = (k: number) => /^\[?(\d{1,3})[\].)]?$/.exec(clean(k));
  for (let k = 0; k < items.length; k++) {
    const m = /^\[?(\d{1,3})[\].)]?\s+(.*)$/.exec(clean(k));
    if (m) { add(Number(m[1]), m[2], items[k].nodeId); continue; }
    if (!bare(k)) continue;
    // Numbers on their own are a list's label column. Read in order, the labels may come one by
    // one (1, entry, 2, entry) or all first (1, 2, 3, entry, entry, entry): pair them up in order.
    let run = k;
    while (run < items.length && bare(run)) run++;
    const count = run - k;
    for (let j = 0; j < count && run + j < items.length; j++) add(Number(bare(k + j)![1]), items[run + j].text, items[run + j].nodeId);
    k = run + count - 1;
  }
  return out;
}

/** A page that lists sources: named or titled like one. */
export const isSourcesName = (s: string) =>
  /^[\W\d_]*(sources?|references?|bibliography|citations?|endnotes|footnotes|notes|works cited)(\s*(and|&)\s*(sources?|references?|notes|citations?))?[\W\d_]*$/i.test(s.trim());

// =============================================================================================
// Language
// =============================================================================================

/**
 * The language of a passage in another script than Latin: Japanese, Korean, Hebrew, Greek and
 * Thai are near certain; Chinese (Han only), Arabic, Russian (Cyrillic) and Hindi (Devanagari) are
 * the likeliest of several that share the script (see SCRIPT_SHARED_BY), so the panel says so.
 * Languages that share the Latin script with the document (a Spanish quote in English) can't be
 * told apart reliably from a few words, so those are left to the designer.
 */
export function detectScriptLanguage(text: string): string | null {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length < 2) return null;
  const share = (re: RegExp) => letters.filter((c) => re.test(c)).length / letters.length;
  if (share(/[\p{Script=Hiragana}\p{Script=Katakana}]/u) > 0.1) return 'ja';
  if (share(/\p{Script=Hangul}/u) > 0.5) return 'ko';
  if (share(/\p{Script=Han}/u) > 0.5) return 'zh';
  if (share(/\p{Script=Arabic}/u) > 0.5) return 'ar';
  if (share(/\p{Script=Hebrew}/u) > 0.5) return 'he';
  if (share(/\p{Script=Cyrillic}/u) > 0.5) return 'ru';
  if (share(/\p{Script=Greek}/u) > 0.5) return 'el';
  if (share(/\p{Script=Thai}/u) > 0.5) return 'th';
  if (share(/\p{Script=Devanagari}/u) > 0.5) return 'hi';
  return null;
}

/** Other languages written in the script a guess was made from, for “change it if so”. */
export const SCRIPT_SHARED_BY: Record<string, string> = {
  zh: 'Japanese text in kanji only', ar: 'Persian and Urdu', ru: 'Ukrainian, Bulgarian and Serbian', hi: 'Marathi and Nepali',
};

/** The primary subtag: "en-US" → "en". */
export const baseLang = (lang: string) => lang.toLowerCase().split('-')[0];

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
  ja: 'Japanese', zh: 'Chinese', ko: 'Korean', ar: 'Arabic', he: 'Hebrew', ru: 'Russian', el: 'Greek',
  th: 'Thai', hi: 'Hindi', pl: 'Polish', sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', tr: 'Turkish',
  uk: 'Ukrainian', bg: 'Bulgarian', sr: 'Serbian', fa: 'Persian', ur: 'Urdu', mr: 'Marathi', ne: 'Nepali', vi: 'Vietnamese',
};
export const languageName = (lang: string) => LANGUAGE_NAMES[baseLang(lang)] ?? lang;
