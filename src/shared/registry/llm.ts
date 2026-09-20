/**
 * The LLM registry. Mirrors `docs/02-architecture.md` section 2.1a (ADR-022).
 *
 * Data only, and the only place an LLM provider or model is named (FR-037).
 * No new providers in v1.
 */
import type { LlmModelDescriptor, ProviderChoice, ProviderDescriptor } from '../types.js';

/** Fixed provider identities plus the shipped, legacy/offline fallbacks. */
export const LLM_REGISTRY: ProviderDescriptor<LlmModelDescriptor>[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    credentialId: 'anthropic',
    models: [
      {
        id: 'claude-haiku-4-5-20251001',
        displayName: 'Claude Haiku 4.5',
        providerId: 'anthropic',
        releasedAt: '2025-10-01',
        status: 'legacy',
        streamingText: true,
        effort: null,
        pricing: { known: true, inputPerMTokUsd: 1.0, outputPerMTokUsd: 5.0 },
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
        providerId: 'openai',
        releasedAt: null,
        status: 'legacy',
        streamingText: true,
        effort: null,
        pricing: { known: true, inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 },
      },
    ],
  },
];

const runtimeModels = new Map<string, Map<string, LlmModelDescriptor>>();

/** Main-process catalog updates the dispatch allowlist without changing provider identity. */
export function registerRuntimeLlmModels(providerId: string, models: LlmModelDescriptor[]): void {
  if (!findLlmProvider(providerId)) throw new Error(`Unknown LLM provider "${providerId}".`);
  runtimeModels.set(providerId, new Map(models.map((model) => [model.id, model])));
}

export function clearRuntimeLlmModels(providerId?: string): void {
  if (providerId) runtimeModels.delete(providerId);
  else runtimeModels.clear();
}

export function findLlmProvider(
  providerId: string,
  registry: ProviderDescriptor<LlmModelDescriptor>[] = LLM_REGISTRY,
): ProviderDescriptor<LlmModelDescriptor> | null {
  return registry.find((p) => p.id === providerId) ?? null;
}

export function findLlmModel(
  choice: ProviderChoice,
  registry: ProviderDescriptor<{ id: string }>[] = LLM_REGISTRY,
): LlmModelDescriptor | null {
  const shipped =
    registry
      .find((provider) => provider.id === choice.providerId)
      ?.models.find((model) => model.id === choice.modelId) ?? null;
  if (shipped) return shipped as LlmModelDescriptor;
  return runtimeModels.get(choice.providerId)?.get(choice.modelId) ?? null;
}

/** Every `providerId:modelId` in the registry, for price-table coverage (TC-156). */
export function llmChoiceKeys(
  registry: ProviderDescriptor<LlmModelDescriptor>[] = LLM_REGISTRY,
): string[] {
  return registry.flatMap((p) => p.models.map((m) => `${p.id}:${m.id}`));
}
