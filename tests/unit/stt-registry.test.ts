/**
 * TASK-012. The registry is the only place a provider is named, and the price
 * table covers everything it names.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LLM_REGISTRY, findLlmModel, llmChoiceKeys } from '../../src/shared/registry/llm.js';
import { STT_REGISTRY, findSttModel, sttChoiceKeys } from '../../src/shared/registry/stt.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface PriceTable {
  version: string;
  llm: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  stt: Record<string, { perAudioMinute: number }>;
}

const pricing = JSON.parse(
  readFileSync(join(repoRoot, 'src', 'main', 'pricing.json'), 'utf8'),
) as PriceTable;

/** TC-156: a registry entry with no price row fails the build. */
describe('TC-156 price table coverage', () => {
  it('prices every STT model by providerId:modelId', () => {
    const missing = sttChoiceKeys().filter((key) => !(key in pricing.stt));
    expect(missing).toEqual([]);
  });

  it('prices every LLM model by providerId:modelId', () => {
    const missing = llmChoiceKeys().filter((key) => !(key in pricing.llm));
    expect(missing).toEqual([]);
  });

  it('has no price row that no registry model claims', () => {
    // A stale row is how a price silently applies to nothing, or worse, keeps
    // applying after the model it priced was renamed.
    expect(Object.keys(pricing.stt).sort()).toEqual(sttChoiceKeys().sort());
    expect(Object.keys(pricing.llm).sort()).toEqual(llmChoiceKeys().sort());
  });

  it('keys both blocks the same way', () => {
    for (const key of [...Object.keys(pricing.stt), ...Object.keys(pricing.llm)]) {
      expect(key).toMatch(/^[a-z0-9-]+:[a-zA-Z0-9.-]+$/);
    }
  });
});

describe('the v1 registry contents match the architecture', () => {
  it('ships the four STT providers and their models', () => {
    expect(sttChoiceKeys().sort()).toEqual(
      [
        'deepgram:nova-2',
        'deepgram:nova-3',
        'elevenlabs:scribe-v2-realtime',
        'openai:gpt-4o-mini-transcribe',
        'openai:gpt-4o-transcribe',
        'openai:whisper-1',
      ].sort(),
    );
  });

  it('marks whisper-1 as the one non-streaming model, with a badge', () => {
    const whisper = findSttModel({ providerId: 'openai', modelId: 'whisper-1' });
    expect(whisper?.streaming).toBe(false);
    expect(whisper?.supportsInterim).toBe(false);
    expect(whisper?.supportsEndpointing).toBe(false);
    expect(whisper?.badge).toBeTruthy();

    const streamingButNotWhisper = STT_REGISTRY.flatMap((p) => p.models).filter(
      (m) => m.id !== 'whisper-1',
    );
    for (const model of streamingButNotWhisper) expect(model.streaming).toBe(true);
  });

  it('accepts the exact PCM the audio worker produces, with no resampling', () => {
    for (const model of STT_REGISTRY.flatMap((p) => p.models)) {
      expect(model.audio).toEqual({ encoding: 'linear16', sampleRate: 16000, channels: 1 });
    }
  });

  it('TC-185 declares confidence support for every model', () => {
    for (const provider of STT_REGISTRY) {
      for (const model of provider.models) {
        expect(typeof model.supportsConfidence).toBe('boolean');
        expect(model.supportsConfidence).toBe(provider.id === 'deepgram');
      }
    }
  });

  it('points each provider at its own credential', () => {
    const byId = Object.fromEntries(STT_REGISTRY.map((p) => [p.id, p.credentialId]));
    expect(byId).toEqual({ deepgram: 'deepgram', openai: 'openai', elevenlabs: 'elevenlabs' });
  });

  it('ships the two v1 LLM models', () => {
    expect(llmChoiceKeys().sort()).toEqual(
      ['anthropic:claude-haiku-4-5-20251001', 'openai:gpt-4o-mini'].sort(),
    );
    expect(
      findLlmModel({ providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' }),
    ).toBeTruthy();
    expect(LLM_REGISTRY.every((p) => p.models.length > 0)).toBe(true);
  });

  it('returns null for a model that is not registered', () => {
    expect(findSttModel({ providerId: 'deepgram', modelId: 'nova-99' })).toBeNull();
    expect(findSttModel({ providerId: 'nope', modelId: 'nova-3' })).toBeNull();
  });
});
