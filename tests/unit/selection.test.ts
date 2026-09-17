/**
 * The Dashboard's selection rules (TASK-042).
 *
 * `src/renderer/**` is verified by E2E, which runs on the Windows target only.
 * The rules themselves are not about a window, so they live in `shared` and are
 * pinned here: a rule that only an E2E run can check is a rule nobody checks on
 * a Linux pull request.
 *
 * `TC-121`, `TC-154` and `TC-158` remain the E2E cases that prove the rules are
 * actually wired to the controls.
 */
import { describe, expect, it } from 'vitest';
import {
  backupConflict,
  latencyConsequence,
  sharedCredentialNotice,
  sharedCredentialProviders,
} from '../../src/shared/registry/selection.js';
import { LLM_REGISTRY } from '../../src/shared/registry/llm.js';
import { STT_REGISTRY } from '../../src/shared/registry/stt.js';
import type {
  LlmModelDescriptor,
  ProviderDescriptor,
  SttModelDescriptor,
} from '../../src/shared/types.js';

const name = (id: string): string =>
  [...STT_REGISTRY, ...LLM_REGISTRY].find((p) => p.id === id)?.displayName ?? id;

/** FR-025: the backup provider must not equal the primary provider. */
describe('FR-025 backup selection', () => {
  it('allows no backup at all', () => {
    expect(backupConflict({ providerId: 'a', modelId: 'm' }, null, name)).toBeNull();
  });

  it('allows a backup from a different provider', () => {
    expect(
      backupConflict({ providerId: 'a', modelId: 'm' }, { providerId: 'b', modelId: 'n' }, name),
    ).toBeNull();
  });

  it('refuses a different model from the same provider, and says why', () => {
    const reason = backupConflict(
      { providerId: 'a', modelId: 'm' },
      { providerId: 'a', modelId: 'n' },
      () => 'Example',
    );
    expect(reason).toContain('Example');
    expect(reason).toMatch(/credential and the service are the same/);
  });

  it('refuses the identical choice too', () => {
    expect(
      backupConflict({ providerId: 'a', modelId: 'm' }, { providerId: 'a', modelId: 'm' }, name),
    ).not.toBeNull();
  });
});

/** FR-038 and NFR-017: the consequence is shown before the choice is saved. */
describe('FR-038 non-streaming consequence', () => {
  const streaming: SttModelDescriptor = {
    id: 'stream',
    displayName: 'Streaming model',
    streaming: true,
    supportsInterim: true,
    supportsEndpointing: true,
    audio: { encoding: 'linear16', sampleRate: 16000, channels: 1 },
    pricePerAudioMinuteUsd: 0.005,
  };
  const batch: SttModelDescriptor = {
    ...streaming,
    id: 'batch',
    displayName: 'Batch model',
    streaming: false,
    supportsInterim: false,
    supportsEndpointing: false,
    batchIntervalMs: 4000,
    badge: 'Accuracy is lower.',
  };

  it('says nothing for a streaming model', () => {
    expect(latencyConsequence(streaming)).toBeNull();
  });

  it('names the NFR-017 budget and the registry badge for a batch model', () => {
    const text = latencyConsequence(batch) ?? '';
    expect(text).toContain('NFR-017');
    expect(text).toContain('7.0 s');
    expect(text).toContain('10.0 s');
    expect(text).toContain('Accuracy is lower.');
  });

  it('contrasts it with the streaming budget, so the cost is a comparison', () => {
    expect(latencyConsequence(batch)).toContain('2.5 s');
  });

  it('carries the display name, and never a hard-coded model name', () => {
    expect(latencyConsequence(batch)).toContain('Batch model');
  });

  /** TC-057: the text is registry data, so a model with no badge still works. */
  it('works for a batch model that declares no badge', () => {
    const noBadge: SttModelDescriptor = { ...batch };
    delete noBadge.badge;
    expect(latencyConsequence(noBadge)).toContain('NFR-017');
    expect(latencyConsequence(noBadge)).not.toContain('Accuracy is lower.');
  });
});

/** ADR-017: one credential can serve both capabilities, and the UI must say so. */
describe('ADR-017 shared credential notice', () => {
  it('names the provider that appears in both shipped registries', () => {
    expect(sharedCredentialProviders()).toEqual(['OpenAI']);
    expect(sharedCredentialNotice()).toContain('OpenAI');
    expect(sharedCredentialNotice()).toMatch(/speech-to-text models and .* language models/);
  });

  it('says nothing when no provider serves both', () => {
    const stt: ProviderDescriptor<SttModelDescriptor>[] = [
      { id: 'a', displayName: 'A', credentialId: 'deepgram', models: [] },
    ];
    const llm: ProviderDescriptor<LlmModelDescriptor>[] = [
      { id: 'b', displayName: 'B', credentialId: 'anthropic', models: [] },
    ];
    expect(sharedCredentialProviders(stt, llm)).toEqual([]);
    expect(sharedCredentialNotice(stt, llm)).toBe('');
  });

  it('names each half from its own descriptor, not from the speech one twice', () => {
    // Both shipped descriptors are called "OpenAI", so reusing one name for
    // both halves reads correctly today and is wrong the moment a credential is
    // shared by two descriptors with different display names.
    const stt: ProviderDescriptor<SttModelDescriptor>[] = [
      { id: 'a', displayName: 'Speech Co', credentialId: 'openai', models: [] },
    ];
    const llm: ProviderDescriptor<LlmModelDescriptor>[] = [
      { id: 'b', displayName: 'Language Co', credentialId: 'openai', models: [] },
    ];
    const notice = sharedCredentialNotice(stt, llm);
    expect(notice).toContain('Speech Co speech-to-text models');
    expect(notice).toContain('Language Co language models');
  });

  it('names every provider that serves both, not only the first', () => {
    const stt: ProviderDescriptor<SttModelDescriptor>[] = [
      { id: 'a', displayName: 'A', credentialId: 'openai', models: [] },
      { id: 'b', displayName: 'B', credentialId: 'anthropic', models: [] },
    ];
    const llm: ProviderDescriptor<LlmModelDescriptor>[] = [
      { id: 'c', displayName: 'C', credentialId: 'openai', models: [] },
      { id: 'd', displayName: 'D', credentialId: 'anthropic', models: [] },
    ];
    expect(sharedCredentialProviders(stt, llm)).toEqual(['A', 'B']);
  });
});
