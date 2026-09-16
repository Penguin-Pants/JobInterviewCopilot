/**
 * TC-151 and TC-056: a provider that did not exist when this code was written
 * becomes selectable and usable with one registry entry and one adapter.
 *
 * TC-155: ElevenLabs is a credential like any other, validated on entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioChunk,
  ProviderDescriptor,
  SttModelDescriptor,
  TranscriptEvent,
} from '../../src/shared/types.js';
import { findSttModel, sttChoiceKeys } from '../../src/shared/registry/stt.js';
import { clearSttProviders, openSttSession, registerSttProvider } from '../../src/main/ai/stt.js';
import type { SttProvider, SttSession } from '../../src/main/ai/stt.js';
import { registerStreamingSttProviders } from '../../src/main/ai/stt/index.js';
import { clearLlmProviders } from '../../src/main/ai/llm.js';
import { registerAllLlmProviders } from '../../src/main/ai/llm/index.js';
import { validateCredential } from '../../src/main/ai/validate.js';

/** One registry entry. Nothing else in the app is edited. */
const FAKE_REGISTRY: ProviderDescriptor<SttModelDescriptor>[] = [
  {
    id: 'acme-speech',
    displayName: 'Acme Speech',
    credentialId: 'deepgram',
    models: [
      {
        id: 'acme-1',
        displayName: 'Acme 1',
        streaming: true,
        supportsInterim: true,
        supportsEndpointing: true,
        audio: { encoding: 'linear16', sampleRate: 16000, channels: 1 },
        pricePerAudioMinuteUsd: 0.005,
      },
      {
        id: 'acme-batch',
        displayName: 'Acme Batch',
        streaming: false,
        supportsInterim: false,
        supportsEndpointing: false,
        audio: { encoding: 'linear16', sampleRate: 16000, channels: 1 },
        pricePerAudioMinuteUsd: 0.001,
      },
    ],
  },
];

/** One adapter. */
function fakeAdapter(): { provider: SttProvider; opened: { gap: number }[] } {
  const opened: { gap: number }[] = [];
  const provider: SttProvider = {
    id: 'acme-speech',
    open: (choice, source, _key, options) => {
      opened.push({ gap: options.turnEndGapMs });
      const handlers: ((t: TranscriptEvent) => void)[] = [];
      const session = {
        source,
        choice,
        push: (_c: AudioChunk) => {
          for (const h of handlers) {
            h({
              source,
              text: 'acme heard you',
              isFinal: true,
              timestamp: 1,
              providerId: choice.providerId,
            });
          }
        },
        close: () => Promise.resolve(),
        on: (e: string, h: (...a: never[]) => void) => {
          if (e === 'transcript') handlers.push(h as (t: TranscriptEvent) => void);
        },
      } as unknown as SttSession;
      return Promise.resolve(session);
    },
    validateKey: () => Promise.resolve({ ok: true }),
  };
  return { provider, opened };
}

beforeEach(() => {
  clearSttProviders();
});

describe('TC-151 the registry makes a new provider usable end to end', () => {
  it('opens a session for a provider the rest of the app has never heard of', async () => {
    const { provider, opened } = fakeAdapter();
    registerSttProvider(provider);

    const session = await openSttSession(
      { providerId: 'acme-speech', modelId: 'acme-1' },
      'interviewer',
      'key',
      { turnEndGapMs: 1100 },
      FAKE_REGISTRY,
    );

    const seen: TranscriptEvent[] = [];
    session.on('transcript', (t) => seen.push(t));
    session.push({ source: 'interviewer', pcm: new ArrayBuffer(32000), timestamp: 0, sequence: 0 });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.providerId).toBe('acme-speech');
    // The user's configured gap reaches a provider written after this test.
    expect(opened).toEqual([{ gap: 1100 }]);
  });

  it('routes the new provider by the model class, not by its id', async () => {
    const { provider } = fakeAdapter();
    registerSttProvider(provider, 'streaming');
    // The same provider id, with a non-streaming model, must not reach the
    // streaming adapter. The decision comes off the descriptor.
    await expect(
      openSttSession(
        { providerId: 'acme-speech', modelId: 'acme-batch' },
        'interviewer',
        'key',
        { turnEndGapMs: 800 },
        FAKE_REGISTRY,
      ),
    ).rejects.toThrow(/No batch speech-to-text adapter/);
  });
});

/** TC-056: capabilities come off the selected model's registry entry. */
describe('TC-056 capability flags come from the registry', () => {
  it('reports endpointing support for a provider id nothing branches on', () => {
    const streaming = findSttModel({ providerId: 'acme-speech', modelId: 'acme-1' }, FAKE_REGISTRY);
    expect(streaming?.supportsEndpointing).toBe(true);
    expect(streaming?.supportsInterim).toBe(true);

    const batch = findSttModel({ providerId: 'acme-speech', modelId: 'acme-batch' }, FAKE_REGISTRY);
    expect(batch?.supportsEndpointing).toBe(false);
  });

  it('answers the same question for a shipped model without naming the provider', () => {
    // Every consumer asks this one function. No consumer compares a string.
    for (const key of sttChoiceKeys()) {
      const [providerId, modelId] = key.split(':') as [string, string];
      expect(findSttModel({ providerId, modelId })).not.toBeNull();
    }
  });
});

/** TC-155: the fourth credential behaves exactly like the other three. */
describe('TC-155 credential validation goes through the registry', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearSttProviders();
    registerStreamingSttProviders();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['elevenlabs', 'api.elevenlabs.io', 'xi-api-key'],
    ['deepgram', 'api.deepgram.com', 'Authorization'],
    ['openai', 'api.openai.com', 'Authorization'],
  ] as const)('validates %s live before the key is saved', async (credentialId, host, header) => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const result = await validateCredential(credentialId, 'a-key');
    expect(result.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain(host);
    expect(init.headers[header]).toContain('a-key');
  });

  it('refuses a rejected key with a reason the user can act on', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const result = await validateCredential('elevenlabs', 'bad');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/rejected this key/);
  });

  it('refuses rather than accepts when the provider is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const result = await validateCredential('elevenlabs', 'k');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be reached/);
  });

  it('validates anthropic through the LLM registry now that TASK-032 has landed', async () => {
    // Milestone 0 and Milestone 2 refused every anthropic key, because no
    // adapter claimed that credential and FR-026 forbids saving one that has
    // not passed live validation. TASK-032 is the adapter, so this is a real
    // request now rather than a refusal.
    registerAllLlmProviders(() => 'k');
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const result = await validateCredential('anthropic', 'k');
    expect(result.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('api.anthropic.com');
    expect(init.headers['x-api-key']).toBe('k');
    clearLlmProviders();
  });

  it('refuses a credential no registry claims rather than accepting it blind', async () => {
    clearLlmProviders();
    clearSttProviders();
    const result = await validateCredential('anthropic', 'k');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not saved/);
  });
});
