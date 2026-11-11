import type { TextRole } from './types.ts';
import type { QualityPreset } from './compress.ts';

export type ColorProfile = 'DOCUMENT' | 'SRGB' | 'DISPLAY_P3_V4';

/** One taggable thing on a frame, as the UI shows it. */
export interface ItemState {
  nodeId: string;
  kind: 'text' | 'image';
  /** Layer name, for orientation. */
  name: string;
  /** Text nodes: TextNode.characters. */
  text?: string;
  /** Text nodes: largest font size in the node, a hint for picking heading levels. */
  fontSize?: number;
  /** Text nodes: heaviest weight in the node (400 regular, 600 semibold…). */
  fontWeight?: number;
  /** Text nodes: name of the applied text style, if any. */
  styleName?: string;
  /** Text nodes: font family, italic, all-caps — with size and weight, the "style" of the text. */
  fontFamily?: string;
  italic?: boolean;
  upper?: boolean;
  /** The layer's direct parent, to spot groups of characters drawn as a pattern. */
  parentId?: string;
  /** Text nodes: the role in effect — set by the designer, or suggested. */
  role?: TextRole;
  /** Text nodes: true when the designer chose the role; false when it is a suggestion. */
  roleSet?: boolean;
  /** Text nodes: why the suggestion was made. */
  reason?: string;
  /** Text nodes: the role comes from a file rule for its text style. */
  ruled?: boolean;
  /** The role, alt text or decorative choice comes from the main component, not this layer. */
  inherited?: boolean;
  /** Text nodes: hyperlinks in the text (Figma exports these as PDF links). */
  links?: Array<{ text: string; url: string; start: number; end: number }>;
  /** Text nodes: language when it differs from the document's ("es", "ja"); langSet when chosen by hand. */
  lang?: string;
  langSet?: boolean;
  /** Text nodes: solid fill color (0–255) and its opacity, for the contrast check. */
  color?: [number, number, number];
  colorAlpha?: number;
  /** Image nodes: alt text. Only used when not decorative. */
  alt?: string;
  /** Image nodes: explicitly decorative — left as an artifact, skipped by screen readers. */
  decorative?: boolean;
  /** Image nodes: true once the designer has decided (typed alt text or set decorative either way). */
  decided?: boolean;
  /** Image nodes: a vector graphic (a logo, a chart) rather than an image fill. */
  vector?: boolean;
  /** Image nodes: a chart drawn with shapes and text; its labels are tagged as part of it. */
  chart?: boolean;
  /** Image nodes: words drawn as shapes (outlined text); the words, when the layer name gives them. */
  outlined?: string;
  /** Text nodes: the chart or diagram this text labels (a value, an axis tick, a callout). */
  inChart?: string;
  /** Image nodes: art with text labels laid over it; the labels are read as part of it. */
  diagram?: boolean;
  /** Diagrams: the label layers as they group (a callout's title and subtitle), in layer order. */
  labelUnits?: string[][];
  /** Diagrams: the labels as last approved in the alt text (see labelsKey); otherwise they're drafted in. */
  labelsChecked?: string;
  /** Diagrams: the alt text has the labels drafted in, waiting for a check. */
  labelsDraft?: boolean;
  /** Image nodes: the alt text is drafted from the layer name, waiting for a check. */
  nameDraft?: boolean;
  /** Text nodes: cropped out of view by a parent frame with Clip content on. */
  clipped?: boolean;
  /** Text nodes: a bullet drawn as a shape sits just left of the first line. */
  bulleted?: boolean;
  /** Text nodes: read as part of another layer (a split heading's next line, a drop cap's paragraph). */
  joinedTo?: string;
  /** What goes between it and the layer before it when joined (a space, or nothing). */
  joinSep?: string;
  /** Text nodes: what to say instead of the characters ("S P E C T E R" → "SPECTER"). */
  spoken?: string;
  /** Text nodes: position among the frame's text layers in paint order (as Figma's PDF lists them). */
  layerIndex?: number;
  /** Image nodes: the main component's name, for instances (e.g. "Acme Logo"). */
  componentName?: string;
  /** Image nodes: what makes two of them "the same graphic" — image hash or component. */
  signature?: string;
  /** Image nodes: blend mode, and whether the layer extends past the frame's edges. */
  blend?: string;
  bleeds?: boolean;
  /** Image nodes: why the suggestion was made, when it was. */
  suggestion?: string;
  /** Image nodes: small PNG preview for the panel. */
  thumb?: Uint8Array;
  naturalWidth?: number;
  naturalHeight?: number;
  /** PDF points, origin bottom-left, relative to the frame. */
  bbox: [number, number, number, number];
  /** The top-level block on the frame this layer belongs to; consecutive items share it. */
  group: string;
  /** Position in the automatic, structure-based reading order. */
  autoIndex: number;
}

export interface FrameState {
  id: string;
  name: string;
  width: number;
  height: number;
  /** In reading order. */
  items: ItemState[];
  /** True when the designer has reordered this frame by hand. */
  orderSet: boolean;
  /** Position among all frames on the page, so a selection can be placed in the whole document. */
  pageIndex?: number;
  /** Detected tables and lists the designer said are not tables or lists (their ids). */
  structuresOff?: string[];
}

export interface DocState {
  title: string;
  language: string;
  /** Image compression preset, applied after tagging. */
  quality: QualityPreset;
  /** Passed straight to Figma's exportAsync. */
  colorProfile: ColorProfile;
  /** File rules: text style → role, applied to every layer in that style that isn't set by hand. */
  styleRoles: Record<string, TextRole>;
  /** Low contrast accepted as a design choice: still measured, no longer in the review list. */
  acceptContrast?: boolean;
  /** Soft warnings the designer chose to keep as they are ("kind:nodeId"). */
  dismissed?: string[];
}

export type ToUI =
  | {
      type: 'state';
      frames: FrameState[];
      /** The page's other frames (text only), so suggestions learn from the whole document. */
      context: FrameState[];
      doc: DocState;
      fileName: string;
      source: 'selection' | 'page';
      /** Every frame the export could include, in export order, and whether it's left out. */
      pages: Array<{ id: string; name: string; skip: boolean }>;
    }
  /** Before anything is read: what Start would read, and whether to read without asking. */
  | { type: 'ready'; pageName: string; frames: number; selected: number; autoRead: boolean }
  | { type: 'exported'; doc: DocState; pages: Array<{ frame: FrameState; pdf: Uint8Array }> }
  /** Reading frames off the canvas: done of total frames. */
  | { type: 'reading'; done: number; total: number }
  /** Exporting frames from Figma: done of total frames. */
  | { type: 'progress'; done: number; total: number }
  | { type: 'rendered'; frameId: string; png: Uint8Array | null }
  /** The designer selected something on the canvas: which page-level frame, and which layers. */
  | { type: 'canvas-selection'; frameId: string | null; nodeIds: string[] }
  | { type: 'error'; message: string };

export type ToSandbox =
  /** Read the frames again. keep: the same frames; otherwise the current selection (or the page). */
  | { type: 'refresh'; keep?: boolean }
  | { type: 'set-role'; nodeId: string; role: TextRole }
  /** cleared: the designer emptied it on purpose (a component's alt must not come back). */
  | { type: 'set-alt'; nodeId: string; alt: string; cleared?: boolean }
  | { type: 'set-decorative'; nodeId: string; decorative: boolean | null }
  /** A diagram's labels, approved as part of its alt text (or '' to draft them in again). */
  | { type: 'set-labels-checked'; nodeId: string; labels: string }
  | { type: 'set-order'; frameId: string; order: string[] }
  | { type: 'set-structures-off'; frameId: string; ids: string[] }
  /** Language for one text layer; '' goes back to the document's language (or what's detected). */
  | { type: 'set-lang'; nodeId: string; lang: string }
  /** Page order and pages left out of the export, saved in the file. */
  | { type: 'set-pages'; order: string[]; skip: string[] }
  /** Turn a citation marker ("[2]") into a link to its source. Changes the text layer. */
  | { type: 'link-citation'; nodeId: string; start: number; end: number; url: string; marker: string }
  /** Read the page as soon as the panel opens (saved for this person, not the file). */
  | { type: 'set-auto-read'; on: boolean }
  /** Back to the start screen: nothing is read again until Start. */
  | { type: 'show-start' }
  /** Open a web page in the browser (only the plugin's own links). */
  | { type: 'open-url'; url: string }
  /** Draw (or clear, with an empty list) numbered reading-order badges over the frames. */
  /** A 1× PNG of a frame, for the contrast check. */
  | { type: 'render'; frameId: string }
  | { type: 'show-order'; frames: Array<{ frameId: string; steps: Array<{ ids: string[]; kind: 'heading' | 'text' | 'figure' | 'table' | 'list' }> }> }
  | { type: 'set-doc'; doc: DocState }
  /** Select these layers on the canvas and bring them into view. */
  | { type: 'select'; nodeIds: string[]; exact?: boolean }
  | { type: 'export' };
