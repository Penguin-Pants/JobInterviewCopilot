import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  classifyHeuristically,
  classifyWithLlm,
} from '../../src/main/ai/actionability.js';
import type { LlmProvider } from '../../src/main/ai/llm.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const architecture = readFileSync(join(repoRoot, 'docs', '02-architecture.md'), 'utf8');

/**
 * The classification prompt as the architecture document specifies it.
 *
 * Read out of the document rather than transcribed here, the way `TC-090`
 * reads section 6: a test holding its own copy of the prompt proves only that
 * the two copies agree, which is not what `TC-181` asks. Scoped to section
 * 3.6a and to its sole unlabelled fence, so a `ts` block added to the section
 * cannot silently become the one compared.
 */
function specifiedClassificationPrompt(): string {
  const start = architecture.indexOf('### 3.6a Actionability classification prompt');
  expect(start, 'section 3.6a is missing from the architecture document').toBeGreaterThan(-1);
  const end = architecture.indexOf('\n### ', start + 1);
  const section = architecture.slice(start, end === -1 ? undefined : end);
  const blocks = [...section.matchAll(/^```\n([\s\S]*?)^```/gm)].map((m) =>
    (m[1] ?? '').replace(/\n$/, ''),
  );
  expect(blocks, 'section 3.6a has no fenced classification prompt').toHaveLength(1);
  return blocks[0] ?? '';
}

describe('TC-167 actionability heuristic', () => {
  it('uses exact acknowledgements before actionable punctuation and leads', () => {
    expect(classifyHeuristically('How are you?')).toBe('non-actionable');
    expect(classifyHeuristically('Okay, so tell me about your work')).toBeNull();
    expect(classifyHeuristically("What's the risk, really?")).toBe('actionable');
    expect(classifyHeuristically('  Tell me about your work')).toBe('actionable');
    expect(classifyHeuristically('It was a productive quarter')).toBeNull();
  });
});

describe('TC-181 classification prompt fidelity', () => {
  it('matches the architecture document byte for byte', () => {
    expect(CLASSIFICATION_SYSTEM_PROMPT).toBe(specifiedClassificationPrompt());
  });
});

describe('TC-168 and TC-181 actionability LLM confirmation', () => {
  it('drains usage and accepts only an exact verdict using the fixed prompt', async () => {
    const specified = specifiedClassificationPrompt();
    const generate = vi.fn(async function* (request) {
      // Against the document, not against the constant: comparing the request
      // to `CLASSIFICATION_SYSTEM_PROMPT` would pass for any prompt at all.
      expect(request.promptOverride?.system).toBe(specified);
      expect(request.promptOverride?.user).toBe('TURN:\npleasant greeting');
      expect(request.promptOverride?.maxTokens).toBe(5);
      expect(request.promptOverride?.temperature).toBe(0);
      yield { delta: ' NON_ACTIONABLE ' };
      yield { usage: { inputTokens: 4, outputTokens: 1 } };
    });
    const provider = { id: 'fake', generate, validateKey: vi.fn() } as unknown as LlmProvider;
    const usage = vi.fn();
    await expect(
      classifyWithLlm(
        'pleasant greeting',
        'classification-1',
        { providerId: 'openai', modelId: 'gpt-4o-mini' },
        provider,
        new AbortController().signal,
        usage,
      ),
    ).resolves.toBe('non-actionable');
    expect(usage).toHaveBeenCalledWith({ inputTokens: 4, outputTokens: 1 });
  });

  it('fails open on a response containing extra explanation', async () => {
    const provider = {
      id: 'fake',
      async *generate() {
        yield { delta: 'NON_ACTIONABLE because this is small talk' };
      },
      validateKey: vi.fn(),
    } as unknown as LlmProvider;
    await expect(
      classifyWithLlm(
        'pleasant greeting',
        'classification-2',
        { providerId: 'openai', modelId: 'gpt-4o-mini' },
        provider,
        new AbortController().signal,
      ),
    ).resolves.toBe('actionable');
  });
});
