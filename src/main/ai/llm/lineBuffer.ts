/**
 * Line buffering (`FR-074`). Mirrors `docs/02-architecture.md` section 3.3.
 *
 * Implemented once, above the adapters, so Anthropic and OpenAI produce
 * identical `CH-208` timing and identical shape. An adapter yields raw deltas
 * and nothing else.
 *
 * This is also where cue form is **enforced** rather than asked for
 * (`FR-004`, ADR-025). A prompt is a request; a model that answers with one
 * long paragraph is not a bug in the prompt, it is the case this file exists
 * to handle.
 */

/** Pending characters with no newline before a flush is forced (FR-074). */
export const FORCED_FLUSH_CHARS = 240;

/** A flushed line longer than this is prose, not a cue (FR-004). */
export const MAX_LINE_CHARS = 120;

/** A card renders at most this many lines. Line 6 onward is never sent (FR-004). */
export const MAX_CARD_LINES = 5;

/** Appended to a line truncated at the cap. One character, so the cap holds. */
export const ELLIPSIS = '…';

/** The buffer's wiring. The three caps default to the `FR-004` values above. */
export interface LineBufferOptions {
  /** One completed bullet, ready for `CH-208`. `index` is zero-based. */
  onLine: (line: string, index: number) => void;
  forcedFlushChars?: number;
  maxLineChars?: number;
  maxCardLines?: number;
}

/**
 * Splits `text` at the last word boundary at or before `limit`.
 *
 * Returns the head and what is left. A single word longer than `limit` has no
 * boundary to cut at, so it is cut at `limit`: holding it instead would let one
 * unbroken token grow the buffer without bound on a live path, and dropping it
 * would lose the only content there is.
 */
export function cutAtWordBoundary(text: string, limit: number): { head: string; rest: string } {
  if (text.length <= limit) return { head: text, rest: '' };
  return cutAt(text, limit);
}

/** The last whitespace index at or before `limit`, or -1. Any whitespace, not just a space. */
function lastBoundary(text: string, limit: number): number {
  for (let i = Math.min(limit, text.length - 1); i > 0; i -= 1) {
    if (/\s/.test(text[i] ?? '')) return i;
  }
  return -1;
}

/**
 * Cuts unconditionally, even when `text` ends exactly at `limit`.
 *
 * The forced flush needs this: a pending string of exactly 240 characters can
 * still end in the middle of a word the next delta continues, and flushing all
 * of it would be the mid-word split `FR-004` forbids.
 */
function cutAt(text: string, limit: number): { head: string; rest: string } {
  const boundary = lastBoundary(text, limit);
  if (boundary <= 0) {
    // One unbroken word longer than the limit. It is cut: holding it would let
    // a single token grow the buffer without bound on a live path, and dropping
    // it would lose the only content there is.
    return { head: text.slice(0, limit), rest: text.slice(limit) };
  }
  return { head: text.slice(0, boundary), rest: text.slice(boundary + 1) };
}

/**
 * Accumulates deltas and emits completed lines.
 *
 * Nothing is emitted per token or per character, which `FR-074` forbids: the
 * count of `CH-208` messages equals the count of lines (TC-093).
 */
export class LineBuffer {
  private pending = '';
  private emitted = 0;
  private sawNewline = false;
  private full = false;

  private readonly onLine: (line: string, index: number) => void;
  private readonly forcedFlushChars: number;
  private readonly maxLineChars: number;
  private readonly maxCardLines: number;

  constructor(options: LineBufferOptions) {
    this.onLine = options.onLine;
    this.forcedFlushChars = options.forcedFlushChars ?? FORCED_FLUSH_CHARS;
    this.maxLineChars = options.maxLineChars ?? MAX_LINE_CHARS;
    this.maxCardLines = options.maxCardLines ?? MAX_CARD_LINES;
  }

  /** True once the card is full. Later deltas are dropped, never sent. */
  get isFull(): boolean {
    return this.full;
  }

  /** The generation produced no newline at all, so far (FR-004, ADR-025). */
  get isNonconforming(): boolean {
    return !this.sawNewline;
  }

  /** One raw delta from an adapter. May be a single character. */
  push(delta: string): void {
    // Once the card is full nothing more is accumulated either. Retaining the
    // tail of a response that can never be shown is pure cost.
    if (this.full || delta === '') return;

    this.pending += delta;

    // Normalized so a provider sending CRLF does not leave a stray CR at the
    // end of every bullet.
    if (this.pending.includes('\r')) this.pending = this.pending.replace(/\r\n?/g, '\n');

    while (!this.full) {
      const newline = this.pending.indexOf('\n');
      if (newline >= 0) {
        this.sawNewline = true;
        const line = this.pending.slice(0, newline);
        this.pending = this.pending.slice(newline + 1);
        this.emit(line);
        continue;
      }
      if (this.pending.length < this.forcedFlushChars) break;

      // Forced flush: the provider is writing prose. Cut at a word boundary and
      // keep the remainder pending, so the stream continues (TC-094).
      const { head, rest } = cutAt(this.pending, this.forcedFlushChars);
      this.pending = rest;
      this.emit(head);
    }
  }

  /**
   * The stream completed. Flushes the remainder and reports the shape.
   *
   * Idempotent: a second call after the first flushes nothing, because a
   * cancellation path and a completion path can both reach it.
   */
  end(): { lines: number; nonconforming: boolean } {
    if (!this.full && this.pending !== '') {
      const remainder = this.pending;
      this.pending = '';
      this.emit(remainder);
    }
    this.pending = '';
    return { lines: this.emitted, nonconforming: this.isNonconforming };
  }

  private emit(raw: string): void {
    const line = raw.trim();
    // A blank line is a paragraph break in the model's output, not a bullet.
    // Sending it would render an empty row on the card and spend one of five.
    if (line === '') return;

    this.onLine(this.capLine(line), this.emitted);
    this.emitted += 1;

    // The card cap. `full` is set here, at the only place a line is counted, so
    // every caller's `full` check is enough and line 6 is never reached rather
    // than reached and discarded.
    if (this.emitted >= this.maxCardLines) {
      this.full = true;
      this.pending = '';
    }
  }

  /**
   * The line cap (`FR-004`). Truncation lands at a word boundary and the
   * ellipsis is inside the cap, so a capped line is never longer than
   * `maxLineChars`. A cap a rendered line can exceed is not a cap.
   */
  private capLine(line: string): string {
    if (line.length <= this.maxLineChars) return line;
    const { head } = cutAtWordBoundary(line, this.maxLineChars - ELLIPSIS.length);
    return `${head.trimEnd()}${ELLIPSIS}`;
  }
}
