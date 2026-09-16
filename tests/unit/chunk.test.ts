import { describe, expect, it } from 'vitest';
import {
  CHUNKER_VERSION,
  chunkMarkdown,
  ensureHeadings,
  SYNTHETIC_HEADING,
  type ChunkOptions,
} from '../../src/main/rag/chunk.js';

/**
 * TASK-021. TC-061, TC-064, TC-065, TC-066, TC-067.
 */

/** One word piece per four characters. Matches `FakeEmbedder`. */
const countTokens = (word: string): number => Math.max(1, Math.ceil(word.length / 4));

function options(overrides: Partial<ChunkOptions> = {}): ChunkOptions {
  return {
    docId: 'doc-1',
    profileId: 'profile-1',
    docType: 'resume',
    sourceFile: 'resume.md',
    maxTokens: 64,
    countTokens,
    ...overrides,
  };
}

/** Token count of a whole text under the counter above, summed per word. */
function tokensOf(text: string): number {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .reduce((sum, word) => sum + countTokens(word), 0);
}

describe('TC-061 synthetic heading', () => {
  it('wraps a body with no heading in exactly one # Document section', () => {
    const chunks = chunkMarkdown('Just a paragraph with no heading at all.', options());

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headerPath).toEqual([SYNTHETIC_HEADING]);
    expect(
      ensureHeadings('body')
        .split('\n')
        .filter((l) => l.startsWith('#')),
    ).toEqual([`# ${SYNTHETIC_HEADING}`]);
  });

  it('leaves a document that already opens a section alone', () => {
    const markdown = '## Experience\n\nBody text.';
    expect(ensureHeadings(markdown)).toBe(markdown);
  });

  it('wraps a document whose headings are all deeper than the splitting levels', () => {
    // A Notion or Obsidian sub-page exports like this. `####` is body text to
    // the splitter, so treating it as "already has a heading" left the whole
    // document in one chunk with an empty headerPath (FR-063).
    const chunks = chunkMarkdown('#### Overview\n\nSome resume text.', options());

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headerPath).toEqual([SYNTHETIC_HEADING]);
    expect(chunks[0]!.text).toContain('#### Overview');
  });

  it('wraps a document whose only hash line is inside a fenced code block', () => {
    const markdown = ['```bash', '# install deps', 'npm i', '```', '', 'I led the migration.'].join(
      '\n',
    );
    const chunks = chunkMarkdown(markdown, options());

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headerPath).toEqual([SYNTHETIC_HEADING]);
  });

  it('strips a byte-order mark so the first heading is still a heading', () => {
    // Notepad and VS Code both write one. Left in place it precedes the first
    // `#`, so the document's own title was dropped from every headerPath.
    const chunks = chunkMarkdown(
      '\uFEFF# Jane Doe\n\nEngineer.\n\n## Experience\n\nAcme.',
      options(),
    );

    expect(chunks.map((c) => c.headerPath)).toEqual([['Jane Doe'], ['Jane Doe', 'Experience']]);
    expect(chunks[0]!.text).not.toContain('\uFEFF');
  });

  it('gives prose before the first heading a synthetic section', () => {
    // `hasSplittingHeading` is true here, so no synthetic wrapper is added, and
    // `toSections` used to flush the preamble with an empty stack.
    const chunks = chunkMarkdown(
      'Intro prose before any heading.\n\n# Experience\n\nAcme.',
      options(),
    );

    expect(chunks.map((c) => c.headerPath)).toEqual([[SYNTHETIC_HEADING], ['Experience']]);
    expect(chunks[0]!.text).toContain('Intro prose');
  });

  it('every chunk of every shape carries a non-empty headerPath (FR-063)', () => {
    const shapes = [
      'No heading at all.',
      '#### Only deep headings\n\nBody.',
      '```\n# fenced\n```\n\nBody.',
      '\uFEFF# Title\n\nBody.',
      '# Real\n\nBody.',
      'Preamble prose.\n\n# Then a heading\n\nBody.',
      '## Starts deeper\n\nBody.',
    ];
    for (const markdown of shapes) {
      for (const chunk of chunkMarkdown(markdown, options())) {
        expect(chunk.headerPath.length, markdown.slice(0, 24)).toBeGreaterThan(0);
      }
    }
  });
});

describe('TC-064 header splitting', () => {
  const markdown = [
    '# Experience',
    'Top level body.',
    '',
    '## Acme Corp',
    'Worked here.',
    '',
    '### Highlights',
    'Shipped a thing.',
    '',
    '#### Sub detail',
    'This stays inside Highlights.',
  ].join('\n');

  it('splits on #, ## and ### and keeps #### inside the parent chunk', () => {
    const chunks = chunkMarkdown(markdown, options());

    expect(chunks.map((c) => c.headerPath)).toEqual([
      ['Experience'],
      ['Experience', 'Acme Corp'],
      ['Experience', 'Acme Corp', 'Highlights'],
    ]);
    expect(chunks[2]!.text).toContain('#### Sub detail');
    expect(chunks[2]!.text).toContain('This stays inside Highlights.');
  });

  it('closes a fence only on its own delimiter, at least as long', () => {
    // CommonMark requires the same character and at least the opening length.
    // Toggling on any delimiter closed a ``` block at an inner ~~~ line, and the
    // `#` after it became a heading, corrupting every following headerPath.
    const tilde = ['```', 'code', '~~~', '# not a heading', '```', '', 'After.'].join('\n');
    expect(chunkMarkdown(tilde, options()).map((c) => c.headerPath)).toEqual([[SYNTHETIC_HEADING]]);

    const shorter = ['````', 'code', '```', '# also not a heading', '````', '', 'After.'].join(
      '\n',
    );
    expect(chunkMarkdown(shorter, options()).map((c) => c.headerPath)).toEqual([
      [SYNTHETIC_HEADING],
    ]);
  });

  it('still closes a fence on a matching, longer delimiter', () => {
    const md = ['# Heading', '', '```', 'code', '`````', '', '## After the fence', 'Body.'].join(
      '\n',
    );
    expect(chunkMarkdown(md, options()).map((c) => c.headerPath)).toEqual([
      ['Heading'],
      ['Heading', 'After the fence'],
    ]);
  });

  it('does not open a section for a heading inside a fenced code block', () => {
    const fenced = ['# Notes', '', '```', '# not a heading', '```', '', 'After the fence.'].join(
      '\n',
    );
    const chunks = chunkMarkdown(fenced, options());

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain('# not a heading');
  });
});

describe('TC-065 header path', () => {
  it('is the ordered ancestor chain, and pops back out on a shallower heading', () => {
    const markdown = [
      '# Experience',
      '## Acme Corp',
      '### Role',
      'Body one.',
      '## Other Co',
      'Body two.',
    ].join('\n');

    const chunks = chunkMarkdown(markdown, options());
    expect(chunks.map((c) => c.headerPath)).toEqual([
      ['Experience', 'Acme Corp', 'Role'],
      ['Experience', 'Other Co'],
    ]);
  });

  it('carries sourceFile, docType and profileId onto every chunk (FR-063)', () => {
    const chunks = chunkMarkdown('# A\nbody\n\n# B\nbody', options());

    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.sourceFile).toBe('resume.md');
      expect(chunk.docType).toBe('resume');
      expect(chunk.profileId).toBe('profile-1');
      expect(chunk.docId).toBe('doc-1');
    }
    expect(chunks.map((c) => c.id)).toEqual(['doc-1#0', 'doc-1#1']);
    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
  });
});

describe('TC-066 token cap at the model limit', () => {
  /** `count` words of four characters each, so one word is one token. */
  const words = (count: number, stem = 'word'): string =>
    Array.from({ length: count }, () => stem).join(' ');

  it('reads the cap from the caller rather than hard-coding one', () => {
    const body = `# Section\n\n${words(300)}`;

    for (const maxTokens of [16, 64, 254]) {
      const chunks = chunkMarkdown(body, options({ maxTokens }));
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(maxTokens);
    }
  });

  it('soft-splits an over-cap section on blank lines', () => {
    // Four-character stems, so each word is exactly one token under this counter.
    const paragraphs = [words(30, 'alph'), words(30, 'brav'), words(30, 'char')];
    const chunks = chunkMarkdown(
      `# Section\n\n${paragraphs.join('\n\n')}`,
      options({ maxTokens: 64 }),
    );

    // Two paragraphs fit in 64 tokens, three do not, so the split lands on a
    // paragraph boundary rather than mid-paragraph.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toBe(`${paragraphs[0]}\n\n${paragraphs[1]}`);
    expect(chunks[1]!.text).toBe(paragraphs[2]);
  });

  it('hard-splits a single over-cap paragraph and loses no text', () => {
    const paragraph = words(175, 'token');
    const chunks = chunkMarkdown(`# Section\n\n${paragraph}`, options({ maxTokens: 64 }));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(64);
    expect(chunks.map((c) => c.text).join(' ')).toBe(paragraph);
  });

  it('splits a single word that alone exceeds the cap rather than emitting it over', () => {
    const giant = 'x'.repeat(500); // 125 tokens under this counter.
    const chunks = chunkMarkdown(`# Section\n\n${giant}`, options({ maxTokens: 16 }));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(16);
    expect(chunks.map((c) => c.text).join('')).toBe(giant);
  });

  it('never splits inside a surrogate pair', () => {
    // A long unbroken emoji or CJK Extension B run is one "word" to the splitter.
    // Slicing by UTF-16 code unit destroyed the character at every boundary.
    for (const maxTokens of [2, 3, 5, 7, 11]) {
      const run = '\u{1F600}'.repeat(60);
      const chunks = chunkMarkdown(`# Section\n\n${run}`, options({ maxTokens }));
      const rejoined = chunks.map((c) => c.text).join('');

      expect(rejoined, `maxTokens ${maxTokens}`).toBe(run);
      for (const chunk of chunks) {
        for (const unit of chunk.text) {
          const code = unit.codePointAt(0) ?? 0;
          expect(code < 0xd800 || code > 0xdfff, `lone surrogate at maxTokens ${maxTokens}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('splits a very long word in linear time rather than quadratic', () => {
    // A pasted base64 data URI or a minified JSON appendix really is one word.
    // Restarting the halving window per piece handed billions of characters to
    // the tokenizer and froze the main process.
    let charsTokenized = 0;
    const counting = (word: string): number => {
      charsTokenized += word.length;
      return countTokens(word);
    };
    const giant = 'x'.repeat(400_000);

    const chunks = chunkMarkdown(`# S\n\n${giant}`, {
      ...options({ maxTokens: 254 }),
      countTokens: counting,
    });

    expect(chunks.map((c) => c.text).join('')).toBe(giant);
    // Quadratic behavior measured ~2700x the input; linear is a small multiple.
    expect(charsTokenized).toBeLessThan(giant.length * 40);
  });

  it('never produces a chunk over the cap for a mixed document', () => {
    const markdown = [
      '# Resume',
      words(20),
      '',
      '## Experience',
      words(400, 'exp'),
      '',
      '### Detail',
      'short',
      '',
      words(90, 'tail'),
    ].join('\n');

    const chunks = chunkMarkdown(markdown, options({ maxTokens: 62 }));
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(62);
      expect(chunk.tokenCount).toBe(tokensOf(chunk.text));
    }
  });

  it('refuses a cap below one rather than looping', () => {
    expect(() => chunkMarkdown('# A\nbody', options({ maxTokens: 0 }))).toThrow(/at least 1/);
  });
});

describe('TC-067 determinism', () => {
  it('produces a deeply equal array for the same bytes', () => {
    const markdown = [
      '# Resume',
      'Summary line that is reasonably long.',
      '',
      '## Experience',
      Array.from({ length: 120 }, (_, i) => `entry${i}`).join(' '),
      '',
      '### Acme',
      'Shipped things.',
    ].join('\n');

    expect(chunkMarkdown(markdown, options())).toEqual(chunkMarkdown(markdown, options()));
  });

  it('exports a chunker version for the cache key (ADR-012)', () => {
    expect(CHUNKER_VERSION).toMatch(/^\d+$/);
  });
});
