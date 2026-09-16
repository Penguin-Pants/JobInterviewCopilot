/**
 * Live credential validation (FR-026).
 *
 * A credential is resolved to an adapter through the registry, not by branching
 * on its id: the first STT provider whose `credentialId` matches owns the check
 * (FR-037). One OpenAI key serves Whisper, the realtime transcription socket and
 * GPT, so validating it once against OpenAI covers every use (ADR-017).
 */
import { STT_REGISTRY } from '../../shared/registry/stt.js';
import type { CredentialId, ValidationResult } from '../../shared/types.js';
import { getSttProvider } from './stt.js';

export async function validateCredential(
  credentialId: CredentialId,
  key: string,
): Promise<ValidationResult> {
  const descriptor = STT_REGISTRY.find((p) => p.credentialId === credentialId);
  const provider = descriptor ? getSttProvider(descriptor.id) : null;
  if (!descriptor || !provider) {
    // Only reached for a credential no STT provider claims. In v1 that is
    // `anthropic`, whose adapter arrives with TASK-032. Refusing rather than
    // accepting keeps FR-026's promise that an unvalidated key is never saved.
    return {
      ok: false,
      reason: `Live validation for ${credentialId} arrives with its provider adapter (TASK-032). The key is not saved until it does.`,
    };
  }

  const modelId = descriptor.models[0]?.id ?? '';
  return provider.validateKey(key, modelId);
}
