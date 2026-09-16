import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { DocumentRecord } from '../../shared/types.js';

/**
 * Document import and conversion (TASK-020, FR-060, FR-061).
 *
 * `.md` is ingested as-is: no derived file is written and `derivedMarkdownPath`
 * stays null. `.pdf` goes through `pdf-parse` and `.docx` through `mammoth`,
 * each producing Markdown written to `derived/<docId>.md`.
 *
 * Both converters are loaded lazily, at the first conversion of that format.
 * They pull large trees, `pdf-parse` a PDF parser and `mammoth` a zip reader,
 * and neither is on the path of a user who only ever drops Markdown in. Loading
 * them at module scope would put that cost on every app start.
 */

export type SourceFormat = DocumentRecord['sourceFormat'];
/** Whether the text came out of the file natively or heuristically (FR-061). */
export type ExtractionQuality = DocumentRecord['extractionQuality'];

/** One converted document (FR-060, FR-061). */
export interface ConversionResult {
  markdown: string;
  /** `'best-effort'` for PDF, whose layout recovery is heuristic (FR-061, TC-062). */
  extractionQuality: ExtractionQuality;
}

/** Raised when a file cannot be converted. Carries a message fit for a Dashboard row. */
export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

const EXTENSIONS: Record<string, SourceFormat> = {
  '.md': 'md',
  '.markdown': 'md',
  '.pdf': 'pdf',
  '.docx': 'docx',
};

/** Extensions the knowledge base watcher and the import dialog accept (FR-060). */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSIONS);

/**
 * Map a file name to its source format (FR-060).
 *
 * @returns null for an unsupported extension, so the watcher can ignore a file
 * rather than creating a document record that can only ever fail.
 */
export function sourceFormatFor(fileName: string): SourceFormat | null {
  return EXTENSIONS[extname(fileName).toLowerCase()] ?? null;
}

const LIST_ITEM = /^\s*([-*\u2022]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s/;

/**
 * Turn a PDF's extracted text into Markdown (FR-060, FR-061).
 *
 * Two repairs, both because a PDF stores glyph positions and not structure:
 *
 * 1. **Rejoin hard wraps.** A sentence laid out over three display lines arrives
 *    as three lines. Left alone, each becomes its own paragraph and the
 *    chunker's soft split on blank lines has nothing but single-line paragraphs
 *    to work with.
 * 2. **Restore paragraph breaks.** A PDF has no blank lines to lose, because a
 *    blank line draws no glyphs, so pdfjs never reports one. A line that ends a
 *    sentence is therefore treated as ending a paragraph, which is what gives
 *    the chunker a boundary to split on at all (FR-062).
 */
export function pdfTextToMarkdown(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\f/g, '\n\n');
  const joined: string[] = [];

  for (const raw of normalized.split('\n')) {
    const line = raw.trim();
    const previous = joined[joined.length - 1];

    const previousIsOpen =
      previous !== undefined &&
      previous.length > 0 &&
      // A line ending in sentence punctuation or a colon was a real break, not a
      // wrap. Rejoining those would run distinct entries together.
      !/[.!?:;]$/.test(previous) &&
      !LIST_ITEM.test(previous) &&
      // A heading is never continued by the line under it. Folding the first
      // body line into the heading would destroy the section boundary the
      // chunker splits on, which is the structure FR-062 depends on.
      !HEADING.test(previous);

    if (line.length === 0 || LIST_ITEM.test(line) || HEADING.test(line) || !previousIsOpen) {
      joined.push(line);
      continue;
    }
    joined[joined.length - 1] = `${previous} ${line}`;
  }

  const spaced: string[] = [];
  for (const line of joined) {
    const previous = spaced[spaced.length - 1];
    const needsBreak =
      previous !== undefined &&
      previous.length > 0 &&
      line.length > 0 &&
      /[.!?]$/.test(previous) &&
      !LIST_ITEM.test(previous) &&
      !LIST_ITEM.test(line);
    if (needsBreak) spaced.push('');
    spaced.push(line);
  }

  return collapseBlankRuns(spaced.join('\n'));
}

/**
 * pdf-parse's page separator, appended to `TextResult.text` but not to a page's
 * own text. It is chrome, not content: embedding it would put "-- 1 of 3 --" in
 * a vector and in a retrieved chunk the user reads.
 */
const PAGE_SEPARATOR = /^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm;

/** Remove pdf-parse's page chrome from a concatenated text (FR-060). */
export function stripPageSeparators(text: string): string {
  return text.replace(PAGE_SEPARATOR, '');
}

/** Two blank lines in a row is a paragraph break; more is noise from the source. */
function collapseBlankRuns(markdown: string): string {
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The pdf-parse v2 surface this app uses.
 *
 * v2 replaced v1's `pdfParse(buffer)` function with a `PDFParse` class that owns
 * a pdfjs worker, so the parser must be destroyed after use or the worker keeps
 * the process alive. Declared locally rather than imported: pulling the real
 * declarations drags `pdfjs-dist`'s types into every compile of the main
 * process for two members.
 */
interface PdfParseConstructor {
  new (options: { data: Uint8Array }): {
    getText(): Promise<{ text: string; pages?: { num: number; text: string }[] }>;
    destroy(): Promise<void>;
  };
}

async function loadPdfParse(): Promise<PdfParseConstructor> {
  const mod: unknown = await import('pdf-parse');
  const namespace = (mod as { default?: unknown }).default ?? mod;
  const candidate = (namespace as { PDFParse?: unknown }).PDFParse;
  if (typeof candidate !== 'function') {
    throw new ConversionError('pdf-parse did not export a PDFParse class.');
  }
  return candidate as PdfParseConstructor;
}

type DocxConverter = (input: { buffer: Buffer }) => Promise<{ value: string }>;

/**
 * mammoth's Markdown converter.
 *
 * Cast because mammoth's own `.d.ts` declares `convertToHtml` and
 * `extractRawText` but not `convertToMarkdown`, which its `lib/index.js` does
 * export. The runtime check below is what actually guards the call.
 */
async function loadDocxConverter(): Promise<DocxConverter> {
  const mod: unknown = await import('mammoth');
  const namespace = (mod as { default?: unknown }).default ?? mod;
  const convert = (namespace as { convertToMarkdown?: unknown }).convertToMarkdown;
  if (typeof convert !== 'function') {
    throw new ConversionError('mammoth did not export convertToMarkdown.');
  }
  return convert as DocxConverter;
}

/**
 * Read a source document and produce Markdown (FR-060, FR-061, TC-060, TC-062).
 *
 * Throws {@link ConversionError} rather than a raw parser error, so a Dashboard
 * row shows a sentence instead of a stack frame. The caller turns that into
 * `state: 'error'`; this function never decides a document's state (TC-063).
 */
export async function convertToMarkdown(
  path: string,
  format: SourceFormat,
): Promise<ConversionResult> {
  // Reading sat outside every try, so ENOENT, EACCES and EISDIR surfaced raw and
  // the caller rendered `Conversion failed: ENOENT: no such file or directory,
  // open '...'` into a Dashboard row, absolute path and all.
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    // The errno, not the message: a Node fs message embeds the absolute path,
    // and this string is rendered in the Dashboard.
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new ConversionError(`Could not read the file (${code}).`);
  }

  if (format === 'md') {
    return { markdown: bytes.toString('utf8'), extractionQuality: 'native' };
  }

  if (format === 'pdf') {
    const PdfParse = await loadPdfParse();
    const parser = new PdfParse({ data: new Uint8Array(bytes) });
    let text: string;
    try {
      const result = await parser.getText();
      // Per-page text is preferred over the concatenated string: the latter has
      // pdf-parse's "-- 1 of 3 --" separators mixed in. The fallback strips them
      // rather than trusting a future version to keep emitting `pages`.
      text = result.pages?.length
        ? result.pages.map((page) => page.text).join('\n\n')
        : stripPageSeparators(result.text);
    } catch (err) {
      throw new ConversionError(`PDF text extraction failed: ${(err as Error).message}`);
    } finally {
      // The parser owns a pdfjs worker. Leaking one per import would keep the
      // process alive after the user closes the app.
      await parser.destroy().catch(() => undefined);
    }
    if (text.trim().length === 0) {
      throw new ConversionError(
        'No text could be extracted from this PDF. A scanned PDF has no text layer.',
      );
    }
    // 'best-effort' is unconditional for PDF, even when extraction went well:
    // the label describes the method, not this file's luck (FR-061).
    return { markdown: pdfTextToMarkdown(text), extractionQuality: 'best-effort' };
  }

  const convert = await loadDocxConverter();
  let value: string;
  try {
    value = (await convert({ buffer: bytes })).value;
  } catch (err) {
    throw new ConversionError(`DOCX conversion failed: ${(err as Error).message}`);
  }
  if (value.trim().length === 0) {
    throw new ConversionError('The DOCX file contains no text.');
  }
  return { markdown: collapseBlankRuns(value), extractionQuality: 'native' };
}
