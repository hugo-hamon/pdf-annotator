import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
} from 'pdf-lib';

export type AnnotationType = 'highlight' | 'underline' | 'note';

export interface Annotation {
  id: string;
  type: AnnotationType;
  /** Zero-based page index. */
  page: number;
  /** Color in #rrggbb format. */
  color: string;
  /** Rectangles in PDF coordinates (bottom-left origin): [x1, y1, x2, y2]. */
  rects: number[][];
  /** Quoted passage. */
  text: string;
  /** User comment. */
  comment: string;
}

const TYPES: AnnotationType[] = ['highlight', 'underline', 'note'];
const FROM_PDF: Record<string, AnnotationType> = { Highlight: 'highlight', Underline: 'underline', Text: 'note' };
const TO_PDF: Record<AnnotationType, string> = { highlight: 'Highlight', underline: 'Underline', note: 'Text' };
/** Annotation subtypes that the extension reads and rewrites. */
const MANAGED = new Set(['Highlight', 'Underline', 'Text', 'Popup']);
/** Private annotation dictionary key storing the quoted passage. */
const QUOTE_KEY = 'VSPdfQuote';
const DEFAULT_COLOR = '#ffd400';

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ---------------------------------------------------------------- utilities

function numbers(arr: PDFArray | undefined): number[] {
  if (!arr) return [];
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) out.push(arr.lookupMaybe(i, PDFNumber)?.asNumber() ?? 0);
  return out;
}

function textOf(dict: PDFDict, key: string): string {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
}

function toHex(c: number[]): string {
  return '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = parseInt(m ? m[1] : DEFAULT_COLOR.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => +(v / 255).toFixed(4));
}

const normalize = ([a, b, c, d]: number[]): number[] => [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];

function union(rects: number[][]): number[] {
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ];
}

/** Validate an annotation received from the webview. */
export function clean(a: any): Annotation | undefined {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !TYPES.includes(a.type)) return undefined;
  if (!Number.isInteger(a.page) || a.page < 0 || !Array.isArray(a.rects) || !a.rects.length) return undefined;
  const rects = a.rects.map((r: unknown) => (Array.isArray(r) && r.length === 4 ? r.map(Number) : null));
  if (rects.some((r: number[] | null) => !r || r.some((n) => !Number.isFinite(n)))) return undefined;
  return {
    id: a.id,
    type: a.type,
    page: a.page,
    color: typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : DEFAULT_COLOR,
    rects: rects.map(normalize),
    text: typeof a.text === 'string' ? a.text : '',
    comment: typeof a.comment === 'string' ? a.comment : '',
  };
}

// ----------------------------------------------------------------- reading

function toAnnotation(dict: PDFDict, subtype: string, page: number): Annotation | undefined {
  const arr = (k: string) => dict.lookupMaybe(PDFName.of(k), PDFArray);
  const quads = numbers(arr('QuadPoints'));
  let rects: number[][] = [];
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]];
    const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]];
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  if (!rects.length) {
    const r = numbers(arr('Rect'));
    if (r.length === 4) rects = [normalize(r)];
  }
  if (!rects.length) return undefined;
  const c = numbers(arr('C'));
  return {
    id: textOf(dict, 'NM') || uid(),
    type: FROM_PDF[subtype],
    page,
    color: c.length === 3 ? toHex(c) : DEFAULT_COLOR,
    rects,
    text: textOf(dict, QUOTE_KEY),
    comment: textOf(dict, 'Contents'),
  };
}

/**
 * Read managed PDF annotations. When `strip` is true, remove their references
 * from the in-memory document so the viewer can draw them separately.
 */
function extract(pdf: PDFDocument, strip: boolean): Annotation[] {
  const found: Annotation[] = [];
  pdf.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const kept: PDFObject[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const subtype = dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      // Keep replies (/IRT) and all annotation types we do not manage.
      if (!dict || !subtype || !MANAGED.has(subtype) || dict.has(PDFName.of('IRT'))) {
        kept.push(annots.get(i));
        continue;
      }
      if (subtype !== 'Popup') {
        const a = toAnnotation(dict, subtype, pageIndex);
        if (!a) {
          kept.push(annots.get(i));
          continue;
        }
        found.push(a);
      }
    }
    if (strip) page.node.set(PDFName.of('Annots'), pdf.context.obj(kept as any));
  });
  return found;
}

export interface LoadedPdf {
  annotations: Annotation[];
  /** PDF bytes for display, with managed annotations drawn by the webview instead. */
  display: Uint8Array;
  encrypted: boolean;
}

export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    if (pdf.isEncrypted) return { annotations: [], display: bytes, encrypted: true };
    const annotations = extract(pdf, true);
    const display = annotations.length ? await pdf.save({ updateFieldAppearances: false }) : bytes;
    return { annotations, display, encrypted: false };
  } catch {
    // Let pdf.js report display errors; saving will fail gracefully if needed.
    return { annotations: [], display: bytes, encrypted: false };
  }
}

// ----------------------------------------------------------------- writing

function appearance(pdf: PDFDocument, a: Annotation, rgb: number[], bbox: number[]): PDFRef {
  const ops = [`${rgb.join(' ')} rg`];
  for (const [x1, y1, x2, y2] of a.rects) {
    ops.push(a.type === 'highlight' ? `${x1} ${y1} ${x2 - x1} ${y2 - y1} re f` : `${x1} ${y1} ${x2 - x1} 1 re f`);
  }
  const stream = pdf.context.stream(`/GS gs\n${ops.join('\n')}`, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: bbox,
    Resources: { ExtGState: { GS: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } },
  });
  return pdf.context.register(stream);
}

function buildDict(pdf: PDFDocument, a: Annotation): PDFDict {
  const rgb = fromHex(a.color);
  const bbox = union(a.rects);
  const dict: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: TO_PDF[a.type],
    Rect: bbox,
    C: rgb,
    F: 4,
    NM: PDFHexString.fromText(a.id),
    T: PDFHexString.fromText('PDF Annotator'),
  };
  if (a.comment) dict.Contents = PDFHexString.fromText(a.comment);
  if (a.text) dict[QUOTE_KEY] = PDFHexString.fromText(a.text);
  if (a.type === 'note') {
    dict.Name = 'Note';
    dict.F = 28; // printable, fixed size, no rotation
    dict.Open = false;
  } else {
    dict.QuadPoints = a.rects.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]);
    dict.AP = { N: appearance(pdf, a, rgb, bbox) };
  }
  return pdf.context.obj(dict as any) as unknown as PDFDict;
}

/** Rewrite all managed annotations and return the updated PDF bytes. */
export async function writeAnnotations(bytes: Uint8Array, annotations: Annotation[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (pdf.isEncrypted) throw new Error('Encrypted PDF');
  extract(pdf, true);
  const byPage = new Map<number, Annotation[]>();
  for (const a of annotations) {
    if (a.page < pdf.getPageCount()) byPage.set(a.page, [...(byPage.get(a.page) ?? []), a]);
  }
  for (const [index, list] of byPage) {
    const page = pdf.getPage(index);
    const refs = list.map((a) => pdf.context.register(buildDict(pdf, a)));
    const existing = page.node.Annots();
    if (existing) refs.forEach((r) => existing.push(r));
    else page.node.set(PDFName.of('Annots'), pdf.context.obj(refs as any));
  }
  return pdf.save({ updateFieldAppearances: false });
}

// ------------------------------------------------------------------ export

export function compare(a: Annotation, b: Annotation): number {
  const top = (x: Annotation) => Math.max(...x.rects.map((r) => r[3]));
  return a.page - b.page || top(b) - top(a) || a.rects[0][0] - b.rects[0][0];
}

/** Export quoted passages and comments as Markdown, grouped by page. */
export function toMarkdown(title: string, annotations: Annotation[]): string {
  const lines = [`# Reading notes — ${title}`, ''];
  let page = -1;
  for (const a of [...annotations].sort(compare)) {
    if (a.type !== 'note' && !a.text && !a.comment) continue;
    if (a.page !== page) {
      page = a.page;
      lines.push(`## Page ${page + 1}`, '');
    }
    if (a.type !== 'note') {
      lines.push(`> ${a.text ? a.text.replace(/\s*\n\s*/g, ' ') : '_(quoted text unavailable)_'}`, '');
    }
    if (a.comment) lines.push(a.type === 'note' ? `**Note:** ${a.comment}` : a.comment, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}
