/**
 * The LLM registry. Mirrors `docs/02-architecture.md` section 2.1a (ADR-022).
 *
 * Data only, and the only place an LLM provider or model is named (FR-037).
 * No new providers in v1.
 */
import type { LlmModelDescriptor, ProviderChoice, ProviderDescriptor } from '../types.js';

export const LLM_REGISTRY: ProviderDescriptor<LlmModelDescriptor>[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    credentialId: 'anthropic',
    models: [
      {
        id: 'claude-haiku-4-5-20251001',
        displayName: 'Claude Haiku 4.5',
        inputPerMTokUsd: 1.0,
        outputPerMTokUsd: 5.0,
      },
    ],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    credentialId: 'openai',
    models: [
      {
        id: 'gpt-4o-mini',
        displayName: 'GPT-4o mini',
        inputPerMTokUsd: 0.15,
        outputPerMTokUsd: 0.6,
      },
    ],
  },
];

export function findLlmProvider(
  providerId: string,
  registry: ProviderDescriptor<LlmModelDescriptor>[] = LLM_REGISTRY,
): ProviderDescriptor<LlmModelDescriptor> | null {
  return registry.find((p) => p.id === providerId) ?? null;
}

export function findLlmModel(
  choice: ProviderChoice,
  registry: ProviderDescriptor<LlmModelDescriptor>[] = LLM_REGISTRY,
): LlmModelDescriptor | null {
  return (
    findLlmProvider(choice.providerId, registry)?.models.find((m) => m.id === choice.modelId) ??
    null
  );
}

/** Every `providerId:modelId` in the registry, for price-table coverage (TC-156). */
export function llmChoiceKeys(
  registry: ProviderDescriptor<LlmModelDescriptor>[] = LLM_REGISTRY,
): string[] {
  return registry.flatMap((p) => p.models.map((m) => `${p.id}:${m.id}`));
}
