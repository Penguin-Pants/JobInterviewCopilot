/**
 * TASK-032. Line buffering and the cue-form rules (`FR-004`, `FR-074`, ADR-025).
 *
 * The structure rules are asserted here rather than against a provider, because
 * this is where they are enforced. A prompt is a request; this file is the part
 * that does not depend on the model agreeing.
 */
import { describe, expect, it } from 'vitest';
import {
  ELLIPSIS,
  FORCED_FLUSH_CHARS,
  LineBuffer,
  MAX_CARD_LINES,
  MAX_LINE_CHARS,
  cutAtWordBoundary,
} from '../../src/main/ai/llm/lineBuffer.js';

function collect(): { lines: string[]; indexes: number[]; buffer: LineBuffer } {
  const lines: string[] = [];
  const indexes: number[] = [];
  const buffer = new LineBuffer({
    onLine: (line, index) => {
      lines.push(line);
      indexes.push(index);
    },
  });
  return { lines, indexes, buffer };
}

/** Feeds a string one character at a time, as a provider streaming deltas does. */
function feedByCharacter(buffer: LineBuffer, text: string): void {
  for (const ch of text) buffer.push(ch);
}

/** TC-093: the message count equals the line count, never the character count. */
describe('TC-093 line buffering', () => {
  it('a 300-character, 4-line response delivered one character at a time emits 4 lines', () => {
    const body = [
      'Led the checkout migration at Acme over two quarters',
      'Cut p95 latency from 900 ms to 240 ms end to end',
      'Ran the on-call rotation and wrote the runbook',
      'Result: 30 percent fewer abandoned carts that year',
    ];
    const response = `${body.join('\n')}\n`;
    expect(response.length).toBeGreaterThan(190);

    const { lines, indexes, buffer } = collect();
    feedByCharacter(buffer, response);
    buffer.end();

    expect(lines).toEqual(body);
    expect(indexes).toEqual([0, 1, 2, 3]);
  });

  it('flushes the remainder when the stream completes without a trailing newline', () => {
    const { lines, buffer } = collect();
    feedByCharacter(buffer, 'first bullet\nsecond bullet');
    expect(lines).toEqual(['first bullet']);

    expect(buffer.end()).toEqual({ lines: 2, nonconforming: false });
    expect(lines).toEqual(['first bullet', 'second bullet']);
  });

  it('never emits a blank line for a paragraph break', () => {
    const { lines, buffer } = collect();
    buffer.push('one\n\n\ntwo\n');
    expect(lines).toEqual(['one', 'two']);
  });

  it('normalizes CRLF rather than leaving a stray carriage return on each bullet', () => {
    const { lines, buffer } = collect();
    buffer.push('one\r\ntwo\r\n');
    expect(lines).toEqual(['one', 'two']);
  });

  it('a second end() flushes nothing', () => {
    const { lines, buffer } = collect();
    buffer.push('only bullet');
    buffer.end();
    buffer.end();
    expect(lines).toEqual(['only bullet']);
  });
});

/** TC-094: the forced flush at 240 characters, and the stream continues. */
describe('TC-094 forced flush', () => {
  it('flushes once at 240 characters with no newline and keeps streaming', () => {
    const { lines, buffer } = collect();
    const words = 'alpha '.repeat(60); // 360 characters, no newline
    feedByCharacter(buffer, words.slice(0, FORCED_FLUSH_CHARS));

    expect(lines).toHaveLength(1);
    expect(buffer.isFull).toBe(false);

    feedByCharacter(buffer, ' beta gamma\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('beta gamma');
  });

  it('never cuts mid-word, even when the pending string ends exactly at the limit', () => {
    const { lines, buffer } = collect();
    // 239 characters, then a word that straddles the boundary.
    buffer.push(`${'ab '.repeat(79)}longtail`);
    expect(lines).toHaveLength(1);
    // The flushed line is then capped, so its body ends on a whole word.
    expect(lines[0]?.slice(0, -ELLIPSIS.length).endsWith('ab')).toBe(true);

    // The proof that nothing was cut mid-word: the straddling word survived
    // whole in the pending remainder rather than being split across two lines.
    buffer.push('continues\n');
    expect(lines[1]).toBe('longtailcontinues');
  });

  it('cuts one unbroken word rather than growing the buffer without bound', () => {
    const { lines, buffer } = collect();
    buffer.push('z'.repeat(FORCED_FLUSH_CHARS * 2));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
  });

  it('cutAtWordBoundary leaves a short string alone', () => {
    expect(cutAtWordBoundary('short enough', 40)).toEqual({ head: 'short enough', rest: '' });
    expect(cutAtWordBoundary('one two three', 8)).toEqual({ head: 'one two', rest: 'three' });
  });
});

/** TC-157: cue form is enforced, not requested (FR-004, ADR-025). */
describe('TC-157 cue-form shape is enforced', () => {
  const paragraph = `${'word '.repeat(179)}end.`; // 899 characters, no newline

  it('a 900-character paragraph produces capped, word-boundary lines and nothing longer', () => {
    const { lines, buffer } = collect();
    feedByCharacter(buffer, paragraph);
    const shape = buffer.end();

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(MAX_CARD_LINES);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
      // Truncation lands on a word boundary: the text before the ellipsis is
      // whole words, never a fragment.
      const body = line.endsWith(ELLIPSIS) ? line.slice(0, -ELLIPSIS.length) : line;
      expect(body).not.toMatch(/\s$/);
      for (const word of body.split(' ')) {
        expect(['word', 'end.', '']).toContain(word);
      }
    }
    expect(shape.nonconforming).toBe(true);
  });

  it('records a generation that emitted no newline as nonconforming', () => {
    const { buffer } = collect();
    buffer.push('one long cue with no newline at all');
    expect(buffer.isNonconforming).toBe(true);
    expect(buffer.end().nonconforming).toBe(true);
  });

  it('a generation with a newline is conforming', () => {
    const { buffer } = collect();
    buffer.push('first\nsecond');
    expect(buffer.end().nonconforming).toBe(false);
  });

  it('caps a long line at a word boundary with an ellipsis inside the cap', () => {
    const { lines, buffer } = collect();
    buffer.push(`${'alpha '.repeat(30)}\n`);
    expect(lines[0]?.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    expect(lines[0]?.endsWith(ELLIPSIS)).toBe(true);
    expect(lines[0]?.slice(0, -ELLIPSIS.length).endsWith('alpha')).toBe(true);
  });

  it('renders at most 5 lines and never sends line 6', () => {
    const { lines, buffer } = collect();
    for (let i = 1; i <= 9; i += 1) buffer.push(`bullet ${String(i)}\n`);
    buffer.end();

    expect(lines).toHaveLength(MAX_CARD_LINES);
    expect(lines.at(-1)).toBe('bullet 5');
    expect(buffer.isFull).toBe(true);
  });

  it('stops accumulating once the card is full', () => {
    const { lines, buffer } = collect();
    for (let i = 1; i <= 5; i += 1) buffer.push(`bullet ${String(i)}\n`);
    buffer.push('x'.repeat(10_000));
    buffer.end();
    expect(lines).toHaveLength(MAX_CARD_LINES);
  });
});
