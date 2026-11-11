/**
 * Semantic role a designer can assign to a text node.
 * 'Artifact' is decorative text — running footers, page numbers, backdrop lettering — which
 * screen readers skip.
 */
export type TextRole = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'P' | 'Artifact';

/** One text node the designer has classified. */
export interface TextItem {
  kind: 'text';
  /** Figma node id, for round-tripping back to the canvas. */
  nodeId: string;
  /** TextNode.characters, used to match against the PDF's /ActualText. */
  text: string;
  role: TextRole;
  /** Where it sits on the page, in PDF points, origin bottom-left. Used for bookmark targets. */
  bbox?: [number, number, number, number];
  /** BCP 47 language when it differs from the document's ("es", "ja"), so it's read with the right voice. */
  lang?: string;
  /** More layers read as part of this one (the rest of a split heading, a drop cap's paragraph, a number's pieces). */
  joined?: Array<{ item: TextItem; sep: string }>;
  /** What to say instead of the characters, when they don't read as written ("S P E C T E R" → "SPECTER"). */
  spoken?: string;
  /** Position among the frame's text layers in paint order: pairs a layer with its run when Figma's export left the run's text out. */
  layerIndex?: number;
}

/** A text item's words with any joined layers: what it reads as. */
export const fullText = (t: TextItem): string => t.text + (t.joined ?? []).map((j) => j.sep + j.item.text).join('');

/** A table: rows of cells, each cell holding zero or more text items. */
export interface TableItem {
  kind: 'table';
  nodeId: string;
  rows: TextItem[][][];
  /** The first row holds column headers. */
  headerRow: boolean;
  /** Header rows at the top, when more than one (a merged heading over its sub-columns). */
  headerRows?: number;
  /** The first column holds row headers. */
  headerCol: boolean;
  /** A short title right above the table, read as its caption. */
  caption?: TextItem;
}

/** A list: each entry an optional label (01, •, a.) and the text it labels. */
export interface ListItem {
  kind: 'list';
  nodeId: string;
  items: Array<{ label?: TextItem; body: TextItem[] }>;
}

/** One image the designer has described. */
export interface ImageItem {
  kind: 'image';
  nodeId: string;
  alt: string;
  /** Natural pixel size of the source bitmap, used to find its XObject. */
  naturalWidth: number;
  naturalHeight: number;
  /** Where it sits on the page, in PDF points, origin bottom-left. */
  bbox: [number, number, number, number];
  /** A vector graphic (a logo): drawn as paths, not as one image, so it's found by its paths. */
  vector?: boolean;
  /** A chart: vector, and its paths may be interleaved with other artwork in the box. */
  chart?: boolean;
  /** A diagram: art with text labels laid over it (an image, a graphic, or a container of shapes). */
  diagram?: boolean;
  /** A chart's or diagram's label layers (node ids). Read as text instead if it can't be tagged. */
  labels?: string[];
}

export type SemanticItem = TextItem | ImageItem | TableItem | ListItem;

/** One Figma frame: its PDF export plus the designer's semantics, in reading order. */
export interface PageInput {
  /** Bytes from frame.exportAsync({ format: 'PDF' }). */
  pdf: Uint8Array;
  /** Frame name, used for the section title. */
  name: string;
  /** In reading order. Every text node on the frame should appear here. */
  items: SemanticItem[];
}

export interface DocumentInput {
  title: string;
  /** BCP 47, e.g. "en-US". */
  language: string;
  pages: PageInput[];
}

export interface TagReport {
  pages: Array<{
    name: string;
    structParents: number;
    mcidCount: number;
    matched: number;
    unmatched: string[];
    defaulted: number[];
    figures: number;
    /** Text runs turned into artifacts because the designer marked them decorative. */
    decorative: number;
    tables: number;
    lists: number;
    /** Hyperlinks carried over from Figma's export, each tied to its link annotation. */
    links: number;
  }>;
  /** Bookmarks made from the H1–H3 headings. */
  bookmarks: number;
  warnings: string[];
  /** Vector drawing code before and after slimming, in bytes (not set when quality is Original). */
  vectors?: { before: number; after: number };
  /** What image compression did, one entry per image (empty when quality is Original). */
  images: Array<{ name: string; from: [number, number]; to: [number, number]; before: number; after: number; kept?: string }>;
}

export interface TagResult {
  pdf: Uint8Array;
  report: TagReport;
}
