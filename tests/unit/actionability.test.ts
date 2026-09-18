import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  classifyHeuristically,
  classifyWithLlm,
} from '../../src/main/ai/actionability.js';
import type { LlmProvider } from '../../src/main/ai/llm.js';

describe('TC-167 actionability heuristic', () => {
  it('uses exact acknowledgements before actionable punctuation and leads', () => {
    expect(classifyHeuristically('How are you?')).toBe('non-actionable');
    expect(classifyHeuristically('Okay, so tell me about your work')).toBeNull();
    expect(classifyHeuristically("What's the risk, really?")).toBe('actionable');
    expect(classifyHeuristically('  Tell me about your work')).toBe('actionable');
    expect(classifyHeuristically('It was a productive quarter')).toBeNull();
  });
});

describe('TC-168 and TC-181 actionability LLM confirmation', () => {
  it('drains usage and accepts only an exact verdict using the fixed prompt', async () => {
    const generate = vi.fn(async function* (request) {
      expect(request.promptOverride?.system).toBe(CLASSIFICATION_SYSTEM_PROMPT);
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
