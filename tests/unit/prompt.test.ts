/**
 * TASK-031. Prompt assembly (`FR-004`, `FR-072`, `FR-073`).
 *
 * TC-090 reads the specification rather than a copy of it. A test holding its
 * own transcription of the system prompt proves the two transcriptions agree,
 * which is not what the requirement asks.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Chunk } from '../../src/shared/types.js';
import type { RetrievedChunk } from '../../src/main/rag.js';
import {
  EMPTY_CANDIDATE_CONTEXT,
  GENERATION_PARAMS,
  SYSTEM_PROMPT,
  buildUserMessage,
} from '../../src/main/ai/prompt.js';
import { buildMessages } from '../../src/main/ai/llm.js';
import { NON_OVERRIDABLE_PROMPT_RULES, SHIPPED_SYSTEM_PROMPT } from '../../src/shared/prompts.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const architecture = readFileSync(join(repoRoot, 'docs', '02-architecture.md'), 'utf8');

/** The fenced blocks of section 6, in order: the system prompt, then the template. */
function sectionSixBlocks(): string[] {
  const start = architecture.indexOf('## 6. Prompt specification');
  expect(start, 'section 6 is missing from the architecture document').toBeGreaterThan(-1);
  const end = architecture.indexOf('\n## ', start + 1);
  const section = architecture.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/```\n([\s\S]*?)```/g)].map((m) => (m[1] ?? '').replace(/\n$/, ''));
}

/** TC-090: the system prompt is byte-identical to the specification. */
describe('TC-090 system prompt fidelity', () => {
  it('matches section 6 of the architecture document byte for byte', () => {
    const [specified] = sectionSixBlocks();
    expect(specified, 'section 6 has no fenced system prompt').toBeTruthy();
    expect(SYSTEM_PROMPT).toBe(specified);
  });

  it('carries the three rules FR-073 requires', () => {
    expect(SYSTEM_PROMPT).toContain('3 to 5 very short bullets');
    expect(SYSTEM_PROMPT).toContain('Never write a paragraph');
    expect(SYSTEM_PROMPT).toContain('STAR-method reminders');
  });
});

function chunk(over: Partial<Chunk> = {}): RetrievedChunk {
  return {
    score: 0.8,
    chunk: {
      id: 'c1',
      docId: 'd1',
      profileId: 'p1',
      index: 0,
      text: 'Cut p95 checkout latency from 900 ms to 240 ms.',
      headerPath: ['Experience', 'Acme'],
      docType: 'resume',
      sourceFile: 'resume.md',
      tokenCount: 12,
      ...over,
    },
  };
}

/** TC-091: the user message template (FR-072). */
describe('TC-091 user message template', () => {
  it('follows the section 6 template, labelling each chunk by type and header path', () => {
    const message = buildUserMessage({
      question: 'Tell me about a performance win',
      candidateContext: 'I mostly worked on checkout',
      chunks: [chunk(), chunk({ id: 'c2', docType: 'company-notes', headerPath: ['Values'] })],
    });

    expect(message).toBe(
      [
        'INTERVIEWER QUESTION:',
        'Tell me about a performance win',
        '',
        'WHAT THE CANDIDATE ALREADY SAID (do not repeat this):',
        'I mostly worked on checkout',
        '',
        'CANDIDATE NOTES:',
        '[1] (resume / Experience > Acme) Cut p95 checkout latency from 900 ms to 240 ms.',
        '[2] (company-notes / Values) Cut p95 checkout latency from 900 ms to 240 ms.',
      ].join('\n'),
    );
  });

  it('renders "(nothing yet)" for an empty candidate context', () => {
    const message = buildUserMessage({
      question: 'Tell me about yourself',
      candidateContext: '   ',
      chunks: [chunk()],
    });
    expect(message).toContain(
      `WHAT THE CANDIDATE ALREADY SAID (do not repeat this):\n${EMPTY_CANDIDATE_CONTEXT}`,
    );
  });

  it('omits the notes section entirely when nothing was retrieved', () => {
    const message = buildUserMessage({
      question: 'Tell me about yourself',
      candidateContext: '',
      chunks: [],
    });
    // Not an empty heading: "CANDIDATE NOTES:" with nothing under it reads as
    // "the notes are empty", a different claim from "no note was relevant".
    expect(message).not.toContain('CANDIDATE NOTES');
    expect(message.endsWith(EMPTY_CANDIDATE_CONTEXT)).toBe(true);
  });

  it('labels a chunk with no header path by its doc type alone', () => {
    const message = buildUserMessage({
      question: 'Tell me about yourself',
      candidateContext: '',
      chunks: [chunk({ headerPath: [] })],
    });
    expect(message).toContain('[1] (resume) Cut p95');
  });

  it('matches the shape of the template block in section 6', () => {
    const [, template] = sectionSixBlocks();
    expect(template, 'section 6 has no fenced user template').toBeTruthy();
    for (const line of [
      'INTERVIEWER QUESTION:',
      'WHAT THE CANDIDATE ALREADY SAID (do not repeat this):',
      'CANDIDATE NOTES:',
    ]) {
      expect(template).toContain(line);
      expect(
        buildUserMessage({ question: 'q', candidateContext: 'c', chunks: [chunk()] }),
      ).toContain(line);
    }
  });
});

describe('generation parameters', () => {
  it('are the section 6 values (TC-092 asserts the adapters send them)', () => {
    expect(GENERATION_PARAMS).toEqual({ maxTokens: 200, temperature: 0.3 });
  });
});

describe('custom suggestion prompt', () => {
  it('replaces only the suggestion system message', () => {
    const messages = buildMessages({
      generationId: 'g1',
      question: 'What did you improve?',
      candidateContext: '',
      chunks: [],
      choice: { providerId: 'anthropic', modelId: 'model' },
      systemPrompt: 'Focus on measurable outcomes.',
    });
    expect(messages.system).toContain('Focus on measurable outcomes.');
    expect(messages.user).toContain('What did you improve?');
    expect(messages.maxTokens).toBe(GENERATION_PARAMS.maxTokens);
  });

  it('keeps the non-overridable rules a custom prompt cannot drop', () => {
    const messages = buildMessages({
      generationId: 'g1',
      question: 'What did you improve?',
      candidateContext: '',
      chunks: [],
      choice: { providerId: 'anthropic', modelId: 'model' },
      systemPrompt: 'Focus on the company values.',
    });
    expect(messages.system).toBe(`Focus on the company values.\n\n${NON_OVERRIDABLE_PROMPT_RULES}`);
  });

  it('does not repeat the rules when the profile uses the shipped prompt', () => {
    const messages = buildMessages({
      generationId: 'g1',
      question: 'What did you improve?',
      candidateContext: '',
      chunks: [],
      choice: { providerId: 'anthropic', modelId: 'model' },
      systemPrompt: SHIPPED_SYSTEM_PROMPT,
    });
    expect(messages.system).toBe(SHIPPED_SYSTEM_PROMPT);
  });
});
