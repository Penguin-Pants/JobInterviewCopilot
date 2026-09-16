/**
 * The STT registry. Mirrors `docs/02-architecture.md` section 2.1a (ADR-022).
 *
 * This file is data. It is the only place an STT provider or model is named
 * (FR-037). Adding a provider is one entry here plus one adapter in
 * `src/main/ai/stt/`; nothing else in the app may branch on a provider id.
 *
 * Capability flags live on the model, not the provider, because one provider
 * can ship both a streaming and a non-streaming model (`openai` ships both).
 *
 * `supportsEndpointing: true` means one thing only: this model's native turn-end
 * signal fires at `settings.trigger.turnEndGapMs`, the gap the user chose. It is
 * not "the provider has some endpoint signal". A provider whose native signal
 * fires on its own schedule would be `false`, and `CMP-05` would run the local
 * timer instead, so the native signal could never preempt the user's value
 * (FR-050, TC-159). All three v1 streaming providers take the gap as a
 * parameter, so all three are `true`:
 *
 * | Model | Parameter carrying `turnEndGapMs` |
 * |---|---|
 * | `deepgram:nova-*` | `endpointing=<ms>` on the socket URL |
 * | `openai:gpt-4o*-transcribe` | `turn_detection.silence_duration_ms` (server VAD) |
 * | `elevenlabs:scribe-v2-realtime` | `min_silence_duration_ms` with the VAD commit strategy |
 *
 * `openai:whisper-1` has no turn signal at all and is `false`.
 */
import type { ProviderChoice, ProviderDescriptor, SttModelDescriptor } from '../types.js';

/** 16 kHz, 16-bit, mono linear PCM: exactly what the Audio Worker produces (FR-041). */
const PCM_16K: SttModelDescriptor['audio'] = {
  encoding: 'linear16',
  sampleRate: 16000,
  channels: 1,
};

export const STT_REGISTRY: ProviderDescriptor<SttModelDescriptor>[] = [
  {
    id: 'deepgram',
    displayName: 'Deepgram',
    credentialId: 'deepgram',
    models: [
      {
        id: 'nova-3',
        displayName: 'Nova 3',
        streaming: true,
        supportsInterim: true,
        supportsEndpointing: true,
        audio: PCM_16K,
        pricePerAudioMinuteUsd: 0.0043,
      },
      {
        id: 'nova-2',
        displayName: 'Nova 2',
        streaming: true,
        supportsInterim: true,
        supportsEndpointing: true,
        audio: PCM_16K,
        pricePerAudioMinuteUsd: 0.0043,
      },
    ],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    credentialId: 'openai',
    models: [
      {
        id: 'gpt-4o-transcribe',
        displayName: 'GPT-4o Transcribe',
        streaming: true,
        supportsInterim: true,
        supportsEndpointing: true,
        audio: PCM_16K,
        pricePerAudioMinuteUsd: 0.006,
      },
      {
        id: 'gpt-4o-mini-transcribe',
        displayName: 'GPT-4o mini Transcribe',
        streaming: true,
        supportsInterim: true,
        supportsEndpointing: true,
        audio: PCM_16K,
        pricePerAudioMinuteUsd: 0.003,
      },
      {
        id: 'whisper-1',
        displayName: 'Whisper (batched)',
        streaming: false,
        supportsInterim: false,
        supportsEndpointing: false,
        audio: PCM_16K,
        pricePerAudioMinuteUsd: 0.006,
        badge: 'Not live. Transcribes in 4 second batches, so suggestions lag a turn behind.',
      },
    ],
  },
  {
    id: 'elevenlabs',
    displayName: 'ElevenLabs',
    credentialId: 'elevenlabs',
    models: [
      {
        id: 'scribe-v2-realtime',
        displayName: 'Scribe v2 Realtime',
        streaming: true,
        supportsInterim: true,
        supportsEndpointing: true,
        audio: PCM_16K,
        pricePerAudioMinuteUsd: 0.0067,
      },
    ],
  },
];

export function findSttProvider(
  providerId: string,
  registry: ProviderDescriptor<SttModelDescriptor>[] = STT_REGISTRY,
): ProviderDescriptor<SttModelDescriptor> | null {
  return registry.find((p) => p.id === providerId) ?? null;
}

/**
 * The single lookup every capability decision goes through. `CMP-05` asks this
 * for `supportsEndpointing` rather than testing the provider id, so a new
 * streaming provider needs no trigger change (FR-037, TC-056).
 */
export function findSttModel(
  choice: ProviderChoice,
  registry: ProviderDescriptor<SttModelDescriptor>[] = STT_REGISTRY,
): SttModelDescriptor | null {
  return (
    findSttProvider(choice.providerId, registry)?.models.find((m) => m.id === choice.modelId) ??
    null
  );
}

/** The `providerId:modelId` key used by the price table and the health map. */
export function choiceKey(choice: ProviderChoice): string {
  return `${choice.providerId}:${choice.modelId}`;
}

/** Every `providerId:modelId` in the registry, for price-table coverage (TC-156). */
export function sttChoiceKeys(
  registry: ProviderDescriptor<SttModelDescriptor>[] = STT_REGISTRY,
): string[] {
  return registry.flatMap((p) => p.models.map((m) => `${p.id}:${m.id}`));
}
