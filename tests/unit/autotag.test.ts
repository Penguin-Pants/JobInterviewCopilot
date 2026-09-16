import { describe, expect, it } from 'vitest';
import { guessDocType, scoreDocTypes, TIE_BREAK_ORDER } from '../../src/main/rag/autotag.js';
import type { DocType } from '../../src/shared/types.js';

/**
 * TASK-023. TC-072: a fixture set of 12 filenames and bodies produces the
 * documented tag for each, deterministically.
 */

interface Fixture {
  name: string;
  fileName: string;
  markdown: string;
  expected: DocType;
}

const RESUME_BODY = [
  '# Professional Summary',
  'Ten years of experience building distributed systems.',
  '',
  '## Experience',
  'Acme Corp, Senior Engineer.',
  '',
  '## Education',
  'B.S. Computer Science. Graduated 2014.',
].join('\n');

const JD_BODY = [
  '# About the Role',
  'We are looking for a senior engineer to join the platform team.',
  '',
  '## Responsibilities',
  'You will design and ship services.',
  '',
  '## Requirements',
  'The ideal candidate has shipped production systems.',
  '',
  '## Benefits',
  'Equal opportunity employer.',
].join('\n');

const NOTES_BODY = [
  '# Company',
  'Founded in 2015 and headquartered in Berlin.',
  '',
  '## Competitors',
  'Two direct competitors, both Series B.',
  '',
  '## Questions to ask',
  'What does the roadmap look like?',
].join('\n');

const FIXTURES: Fixture[] = [
  // Filename alone is decisive when the body says nothing.
  {
    name: 'resume by filename',
    fileName: 'resume.pdf',
    markdown: 'Some text.',
    expected: 'resume',
  },
  { name: 'cv by filename', fileName: 'Jane-CV.docx', markdown: 'Some text.', expected: 'resume' },
  {
    name: 'curriculum vitae by filename',
    fileName: 'curriculum_vitae.md',
    markdown: 'Some text.',
    expected: 'resume',
  },
  {
    name: 'job description by filename',
    fileName: 'job-description.md',
    markdown: 'Some text.',
    expected: 'job-description',
  },
  {
    name: 'posting by filename',
    fileName: 'senior-engineer-posting.pdf',
    markdown: 'Some text.',
    expected: 'job-description',
  },
  {
    name: 'notes by filename',
    fileName: 'acme-research.md',
    markdown: 'Some text.',
    expected: 'company-notes',
  },

  // Content alone is decisive when the filename says nothing.
  {
    name: 'resume by content',
    fileName: 'untitled-1.md',
    markdown: RESUME_BODY,
    expected: 'resume',
  },
  {
    name: 'job description by content',
    fileName: 'untitled-2.md',
    markdown: JD_BODY,
    expected: 'job-description',
  },
  {
    name: 'company notes by content',
    fileName: 'untitled-3.md',
    markdown: NOTES_BODY,
    expected: 'company-notes',
  },

  // A filename that names one type beats a body that merely leans another way.
  {
    name: 'filename outweighs weak body signals',
    fileName: 'my-resume.md',
    markdown: 'We are looking for someone. You will do things.',
    expected: 'resume',
  },

  // Nothing matches, so the tie-break decides.
  {
    name: 'no signal falls back to the tie-break head',
    fileName: 'x.md',
    markdown: 'Nothing recognizable here whatsoever.',
    expected: 'company-notes',
  },
  {
    name: 'empty document falls back to the tie-break head',
    fileName: 'y.md',
    markdown: '',
    expected: 'company-notes',
  },
];

describe('TC-072 auto-tag rules', () => {
  it('has twelve fixtures, as the test case specifies', () => {
    expect(FIXTURES).toHaveLength(12);
  });

  for (const fixture of FIXTURES) {
    it(`tags ${fixture.name} as ${fixture.expected}`, () => {
      expect(guessDocType(fixture.fileName, fixture.markdown)).toBe(fixture.expected);
    });
  }

  it('is deterministic: the same input always produces the same tag', () => {
    for (const fixture of FIXTURES) {
      const first = guessDocType(fixture.fileName, fixture.markdown);
      for (let i = 0; i < 5; i += 1) {
        expect(guessDocType(fixture.fileName, fixture.markdown)).toBe(first);
      }
    }
  });

  it('scores every doc type and explains which rules fired', () => {
    const scores = scoreDocTypes('resume.md', RESUME_BODY);
    expect(scores).toHaveLength(3);

    const resume = scores.find((s) => s.docType === 'resume')!;
    expect(resume.matched.some((m) => m.startsWith('filename:'))).toBe(true);
    expect(resume.matched.some((m) => m.startsWith('heading:'))).toBe(true);
    expect(resume.score).toBeGreaterThan(
      Math.max(...scores.filter((s) => s.docType !== 'resume').map((s) => s.score)),
    );
  });

  it('caps the body contribution so prose cannot outvote a filename', () => {
    // A resume filename against a body stuffed with job-description phrases.
    const stuffed = [
      'We are looking for someone.',
      'The ideal candidate will thrive.',
      'You will ship code.',
      'Nice-to-have: Rust.',
      'Minimum qualifications apply.',
      'Reports to the VP.',
      'Equal opportunity employer.',
    ].join('\n\n');

    expect(guessDocType('resume.md', stuffed)).toBe('resume');
  });

  it('resolves a tie in the documented order', () => {
    expect(TIE_BREAK_ORDER).toEqual(['company-notes', 'job-description', 'resume']);
    // Both filename patterns match, so both types score 10 and the head wins.
    expect(guessDocType('company-notes-and-job-description.md', '')).toBe('company-notes');
  });
});
