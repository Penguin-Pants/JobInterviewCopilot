import type { Chunk, DocType } from '../../shared/types.js';

/**
 * Markdown chunking (TASK-021, FR-062, FR-063, ADR-023, ASM-001).
 *
 * Pure and deterministic: the same input bytes always produce a deeply equal
 * chunk array (TC-067). Nothing here touches the filesystem, the clock or a
 * random source, which is what lets {@link CHUNKER_VERSION} participate in the
 * cache key at all (ADR-012). If chunking were not a function of its input, a
 * cache hit would not mean the chunks are the ones the vectors were built from.
 */

/**
 * Bump on any change to the chunking algorithm (ADR-012).
 *
 * Part of every document's `embeddingKey`, so a bump invalidates every cached
 * vector with no manual purge (TC-070).
 */
export const CHUNKER_VERSION = '1';

/**
 * Counts word pieces for one pre-tokenizer token, usually a single word.
 *
 * Deliberately per-word rather than per-string. A BERT-family tokenizer, which
 * is what MiniLM uses, pre-tokenizes on whitespace and punctuation and then runs
 * WordPiece inside each piece, so a text's token count is the sum of its words'
 * token counts. That makes the greedy packing below linear instead of
 * quadratic: a per-string counter would re-tokenize the whole accumulated
 * candidate once per added word.
 */
export type TokenCounter = (word: string) => number;

/** What the chunker needs about the document and the model (FR-062, FR-063). */
export interface ChunkOptions {
  docId: string;
  profileId: string;
  docType: DocType;
  /** `originalFileName`, carried onto every chunk (FR-063). */
  sourceFile: string;
  /**
   * Word pieces of real content a chunk may carry. Comes from the downloaded
   * model's `max_seq_length` less its special tokens, never a literal, so a
   * model swap cannot reintroduce truncation (FR-062, ADR-023, TC-066).
   */
  maxTokens: number;
  countTokens: TokenCounter;
}

/** A heading and the body that belongs to it, before any size splitting. */
interface Section {
  headerPath: string[];
  body: string;
}

/** `#`, `##` and `###` open a section. `####` and deeper are body text (FR-062). */
const SPLITTING_HEADING = /^(#{1,3})\s+(.+?)\s*$/;

/** The section a body with no heading of its own is wrapped in (FR-061). */
export const SYNTHETIC_HEADING = 'Document';

/**
 * A fenced code block delimiter, capturing the run so its marker and length can
 * be compared. CommonMark closes a fence only on the same character, at least as
 * long as the opening run.
 */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * A UTF-8 byte-order mark, which Notepad and VS Code both write.
 *
 * Left in place it precedes the first `#`, so `\uFEFF# Jane Doe` matches no
 * heading pattern and the document's own title is silently dropped from every
 * `headerPath` (FR-063).
 */
const BOM = '\uFEFF';

/**
 * Give a body at least one heading the chunker will actually split on
 * (FR-061, FR-063, TC-061).
 *
 * Applied to every document before chunking, not only to converted ones: a
 * hand-written `.md` with no heading has the same problem, an entire document
 * collapsed into one unlabeled chunk with an empty `headerPath`. The original
 * file is never rewritten, so `.md` is still ingested as-is (FR-060); only the
 * text handed to the chunker gains the section.
 *
 * The test has to be the splitter's own, run through the splitter's own fence
 * tracking. Testing "any ATX heading" instead let three ordinary documents
 * through with an empty `headerPath`:
 *
 * - one whose headings all start at `####`, which is what a Notion or Obsidian
 *   sub-page exports as;
 * - one whose only `#` line is a shell comment inside a fenced code block;
 * - one saved with a byte-order mark, where the mark precedes the first `#`.
 *
 * @returns the body unchanged when it already opens a section, with the mark
 * stripped either way.
 */
export function ensureHeadings(markdown: string): string {
  const body = markdown.startsWith(BOM) ? markdown.slice(BOM.length) : markdown;
  if (hasSplittingHeading(body)) return body;
  return `# ${SYNTHETIC_HEADING}\n\n${body.trim()}\n`;
}

/** Whether any line outside a fence opens a section, by the splitter's own rules. */
function hasSplittingHeading(markdown: string): boolean {
  let fence: { marker: string; length: number } | null = null;
  for (const line of markdown.split('\n')) {
    const delimiter = FENCE.exec(line);
    if (delimiter) {
      const marker = (delimiter[1] ?? '')[0] ?? '';
      const length = (delimiter[1] ?? '').length;
      if (!fence) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length) fence = null;
      continue;
    }
    if (!fence && SPLITTING_HEADING.test(line)) return true;
  }
  return false;
}

/**
 * Split Markdown into heading-delimited sections, carrying the ancestor chain.
 *
 * A fenced code block can contain a line that looks like a heading. Fences are
 * tracked so `# not a heading` inside ``` does not open a section.
 */
function toSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let body: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  const flush = (): void => {
    const text = body.join('\n').trim();
    if (text.length > 0) {
      // A document may open with prose before its first heading. Flushing that
      // preamble with an empty stack gave it `headerPath: []`, which breaks
      // FR-063's guarantee that every chunk carries its ancestor chain, so it
      // gets the same synthetic section a heading-less document gets.
      const headerPath = stack.length > 0 ? stack.map((s) => s.title) : [SYNTHETIC_HEADING];
      sections.push({ headerPath, body: text });
    }
    body = [];
  };

  for (const line of markdown.split('\n')) {
    const delimiter = FENCE.exec(line);
    if (delimiter) {
      const marker = (delimiter[1] ?? '')[0] ?? '';
      const length = (delimiter[1] ?? '').length;
      if (!fence) fence = { marker, length };
      // CommonMark closes a fence only on the same character, at least as long
      // as the opener. Toggling on any delimiter closed a ``` block at an inner
      // ~~~ line, or a ```` block at an inner ```, and the `#` lines after it
      // were then read as headings, corrupting every following headerPath.
      else if (marker === fence.marker && length >= fence.length) fence = null;
      body.push(line);
      continue;
    }

    const heading = fence ? null : SPLITTING_HEADING.exec(line);
    if (!heading) {
      body.push(line);
      continue;
    }

    flush();
    const level = (heading[1] ?? '').length;
    const title = heading[2] ?? '';
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    stack.push({ level, title });
  }
  flush();
  return sections;
}

/**
 * Split one over-budget paragraph at a token boundary, losing no text (TC-066).
 *
 * Words are the split unit, so no word is lost or cut. The pieces rejoin with a
 * single space, so a run of spaces or a tab inside the paragraph is normalized
 * away; the text survives, its exact inner whitespace does not. A single word
 * that alone exceeds the budget, which a long URL or a base64 blob can be, is
 * split by code point rather than emitted over the cap: emitting it would put a
 * silently truncated chunk back in the store, which is the whole point of
 * ADR-023.
 */
function hardSplit(paragraph: string, maxTokens: number, countTokens: TokenCounter): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length > 0) pieces.push(current.join(' '));
    current = [];
    currentTokens = 0;
  };

  for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
    const wordTokens = countTokens(word);

    if (wordTokens > maxTokens) {
      flush();
      for (const slice of splitOversizeWord(word, maxTokens, countTokens)) pieces.push(slice);
      continue;
    }
    if (currentTokens + wordTokens > maxTokens) flush();
    current.push(word);
    currentTokens += wordTokens;
  }
  flush();
  return pieces;
}

/**
 * Split a single word that exceeds the budget on its own.
 *
 * Two things this gets right that the obvious version does not.
 *
 * **It splits on code points, not code units.** `String` indices are UTF-16 code
 * units, so slicing at an arbitrary index can land between a surrogate pair and
 * destroy the character: the first piece ends in a lone high surrogate and the
 * next begins with a lone low one, both of which render as a replacement
 * character and are mangled again when the chunk is serialized for an LLM
 * request. Emoji and CJK Extension B are the common cases, and a long
 * whitespace-free run of either is exactly the input that reaches this function.
 *
 * **The window never restarts.** Halving from `rest.length` on every outer
 * iteration re-measures the whole remaining string once per piece, which is
 * quadratic: a 2 MB whitespace-free word, which a pasted base64 data URI or a
 * minified JSON appendix really is, handed 5.8 billion characters to the
 * tokenizer and froze the main process. The window found for one piece is
 * carried into the next, so each code point is measured a bounded number of
 * times.
 */
function splitOversizeWord(word: string, maxTokens: number, countTokens: TokenCounter): string[] {
  const points = Array.from(word);
  const pieces: string[] = [];
  let start = 0;
  // Carried across iterations: the next piece is never longer than this one.
  let window = points.length;

  while (start < points.length) {
    let take = Math.min(window, points.length - start);
    while (take > 1 && countTokens(points.slice(start, start + take).join('')) > maxTokens) {
      take = Math.floor(take / 2);
    }
    pieces.push(points.slice(start, start + take).join(''));
    start += take;
    window = Math.max(1, take);
  }
  return pieces;
}

/**
 * Pack a section body into pieces that each fit the budget.
 *
 * Soft-splits on blank lines first, so a split lands on a paragraph boundary
 * wherever one is available, and only hard-splits a paragraph that is over
 * budget by itself (FR-062).
 */
function packBody(body: string, maxTokens: number, countTokens: TokenCounter): string[] {
  const tokensOf = (text: string): number =>
    text
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .reduce((sum, word) => sum + countTokens(word), 0);

  if (tokensOf(body) <= maxTokens) return [body];

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const pieces: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length > 0) pieces.push(current.join('\n\n'));
    current = [];
    currentTokens = 0;
  };

  for (const paragraph of paragraphs) {
    const paragraphTokens = tokensOf(paragraph);

    if (paragraphTokens > maxTokens) {
      flush();
      for (const piece of hardSplit(paragraph, maxTokens, countTokens)) pieces.push(piece);
      continue;
    }
    if (currentTokens + paragraphTokens > maxTokens) flush();
    current.push(paragraph);
    currentTokens += paragraphTokens;
  }
  flush();
  return pieces;
}

/**
 * Chunk a Markdown document (FR-062, FR-063).
 *
 * Splits on `#`, `##` and `###`; `####` and deeper stay inside the parent chunk
 * as body text. Every chunk carries `{ sourceFile, headerPath, docType,
 * profileId }` and its `tokenCount`, and no chunk exceeds `maxTokens` (TC-064,
 * TC-065, TC-066).
 *
 * Memoizes the token count per distinct word. A resume repeats its vocabulary
 * heavily, and the memo is what keeps a 2 MB document linear rather than
 * tokenizing the same word thousands of times.
 */
export function chunkMarkdown(markdown: string, options: ChunkOptions): Chunk[] {
  const { docId, profileId, docType, sourceFile, maxTokens } = options;
  if (maxTokens < 1) throw new Error(`maxTokens must be at least 1, received ${maxTokens}.`);

  const memo = new Map<string, number>();
  const countTokens: TokenCounter = (word) => {
    const cached = memo.get(word);
    if (cached !== undefined) return cached;
    const value = options.countTokens(word);
    memo.set(word, value);
    return value;
  };

  const chunks: Chunk[] = [];
  for (const section of toSections(ensureHeadings(markdown))) {
    for (const text of packBody(section.body, maxTokens, countTokens)) {
      const tokenCount = text
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .reduce((sum, word) => sum + countTokens(word), 0);

      const index = chunks.length;
      chunks.push({
        id: `${docId}#${index}`,
        docId,
        profileId,
        index,
        text,
        headerPath: [...section.headerPath],
        docType,
        sourceFile,
        tokenCount,
      });
    }
  }
  return chunks;
}
