/**
 * Live credential validation (FR-026).
 *
 * A credential is resolved to an adapter through the registries, not by
 * branching on its id: the first provider whose `credentialId` matches owns the
 * check (FR-037). One key can serve several models and several capabilities, so
 * it is validated once against its provider and that covers every use (ADR-017).
 *
 * The STT registry is consulted first only because it is the larger of the two.
 * `openai` appears in both and is checked once either way, against the same
 * endpoint.
 */
import { LLM_REGISTRY } from '../../shared/registry/llm.js';
import { STT_REGISTRY } from '../../shared/registry/stt.js';
import type { CredentialId, ValidationResult } from '../../shared/types.js';
import { getLlmProvider } from './llm.js';
import { getSttProvider } from './stt.js';

export async function validateCredential(
  credentialId: CredentialId,
  key: string,
): Promise<ValidationResult> {
  const sttDescriptor = STT_REGISTRY.find((p) => p.credentialId === credentialId);
  const sttProvider = sttDescriptor ? getSttProvider(sttDescriptor.id) : null;
  if (sttDescriptor && sttProvider) {
    return sttProvider.validateKey(key, sttDescriptor.models[0]?.id ?? '');
  }

  // `anthropic` is the v1 credential no STT provider claims. Its adapter landed
  // with TASK-032, so this is now a real check rather than the refusal that
  // used to stand here.
  const llmDescriptor = LLM_REGISTRY.find((p) => p.credentialId === credentialId);
  const llmProvider = llmDescriptor ? getLlmProvider(llmDescriptor.id) : null;
  if (llmProvider) return llmProvider.validateKey(key);

  // Reached only for a credential no registry claims, or before adapters are
  // registered. Refusing rather than accepting keeps FR-026's promise that an
  // unvalidated key is never saved.
  return {
    ok: false,
    reason: `No provider adapter can validate a ${credentialId} key. The key is not saved.`,
  };
}
