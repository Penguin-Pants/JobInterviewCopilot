/**
 * Prompt assembly (`CMP-07`, TASK-031). Mirrors `docs/02-architecture.md`
 * section 6 (FR-004, FR-072, FR-073).
 *
 * Pure: strings in, one string out. No provider, no network, no Electron. Both
 * adapters send the same two messages, so a difference in what a provider
 * answers is the provider's, not the prompt's.
 */
import type { RetrievedChunk } from '../rag.js';
import { SHIPPED_SYSTEM_PROMPT } from '../../shared/prompts.js';

/**
 * The shipped default system prompt (FR-073).
 *
 * `TC-090` reads section 6 of the architecture document and compares byte for
 * byte, so this constant cannot drift from the specification without failing
 * the build. Keep the line breaks exactly as they are: they are part of what is
 * compared.
 */
export const SYSTEM_PROMPT = SHIPPED_SYSTEM_PROMPT;

/**
 * Generation parameters, identical for both providers (FR-070, FR-072, TC-092).
 *
 * Low temperature because the goal is factual recall, not creativity, and
 * `max_tokens` is the outer bound on a card that renders at most five lines.
 */
export const GENERATION_PARAMS = { maxTokens: 200, temperature: 0.3 } as const;

/** What the user message renders when the candidate has not spoken yet (FR-072). */
export const EMPTY_CANDIDATE_CONTEXT = '(nothing yet)';

/** The three inputs `FR-072` names: the question, the ring and the top chunks. */
export interface UserMessageInput {
  /** The interviewer's accumulated turn text (FR-072). */
  question: string;
  /** The candidate context ring, already capped by the trigger (FR-052). */
  candidateContext: string;
  /** The top chunks from `RagEngine.query`, up to 3 (FR-072). */
  chunks: RetrievedChunk[];
}

/** `[1] (resume / Experience > Acme) ...` — the label in section 6's template. */
function renderChunk(hit: RetrievedChunk, position: number): string {
  const { chunk } = hit;
  const heading = chunk.headerPath.join(' > ');
  // A chunk with no header path renders its doc type alone rather than a label
  // ending in a dangling separator. Milestone 2 guarantees a header path for
  // every chunk it writes; a hand-edited file is not owed a broken label.
  const label = heading === '' ? chunk.docType : `${chunk.docType} / ${heading}`;
  return `[${String(position)}] (${label}) ${chunk.text}`;
}

/**
 * The user message of `docs/02-architecture.md` section 6 (TC-091).
 *
 * Zero chunks omits the notes section entirely. An empty `CANDIDATE NOTES:`
 * heading reads as "the notes are empty", which is a different claim from "no
 * note was relevant" and is the one the model would answer.
 */
export function buildUserMessage(input: UserMessageInput): string {
  const context = input.candidateContext.trim();
  const sections = [
    `INTERVIEWER QUESTION:\n${input.question.trim()}`,
    `WHAT THE CANDIDATE ALREADY SAID (do not repeat this):\n${
      context === '' ? EMPTY_CANDIDATE_CONTEXT : context
    }`,
  ];

  if (input.chunks.length > 0) {
    const notes = input.chunks.map((hit, i) => renderChunk(hit, i + 1)).join('\n');
    sections.push(`CANDIDATE NOTES:\n${notes}`);
  }

  return sections.join('\n\n');
}
