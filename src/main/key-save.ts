import type { CredentialId, ValidationResult } from '../shared/types.js';
import type { KeyValidator } from './secrets.js';

/**
 * Everything a validated key save reaches besides the vault (`CH-103`).
 *
 * Injected rather than imported, so the wiring is unit tested instead of living
 * in `index.ts`, which a test cannot import (FR-026, FR-117, ADR-050, ADR-051).
 */
export interface KeySaveDeps {
  vault: {
    set(credentialId: CredentialId, key: string, validate: KeyValidator): Promise<ValidationResult>;
  };
  /** The live check a key must pass before anything is written (FR-026). */
  validate: KeyValidator;
  sttCatalog: { invalidate(credentialId: CredentialId): void };
  llmCatalog: { invalidate(provider: string): void; refresh(): Promise<unknown> };
  health: { noteKeySaved(credentialId: CredentialId): void };
  /** Whether the credential also serves a language model, whose catalog is then stale too. */
  servesLlm(credentialId: CredentialId): boolean;
  warn(message: string, detail: unknown): void;
}

/**
 * `secrets:set` (`CH-103`): validate and save a key, then retire what was
 * derived from the credential it replaces (FR-026, FR-117, ADR-050, ADR-051).
 *
 * A key that fails validation was never saved and changes nothing. A saved one
 * invalidates its speech-to-text catalog entry, so a discovery started with the
 * old key cannot repopulate it (`TC-196`), clears `CONFIG_REQUIRED` for that
 * credential (ADR-024), and, for a credential that also serves a language
 * model, invalidates and refreshes that catalog.
 *
 * The key is already stored by the time either catalog is invalidated, so a
 * catalog that cannot persist its invalidation must not report the save as
 * failed. Both drop the entry from memory before writing, so this process
 * still refreshes it on the next request.
 */
export async function saveProviderKey(
  deps: KeySaveDeps,
  credentialId: CredentialId,
  key: string,
): Promise<ValidationResult> {
  const result = await deps.vault.set(credentialId, key, deps.validate);
  if (!result.ok) return result;

  try {
    deps.sttCatalog.invalidate(credentialId);
  } catch (error) {
    deps.warn('STT catalog cache invalidation could not be persisted', error);
  }
  // Guarded for the same reason: the key is stored, so a throw here must not
  // report a failed save or skip the language-model steps below.
  try {
    deps.health.noteKeySaved(credentialId);
  } catch (error) {
    deps.warn('provider health could not note the saved key', error);
  }
  if (deps.servesLlm(credentialId)) {
    // Guarded like the entry above. Unguarded, a failed write threw out of the
    // handler after the key was saved, so the Dashboard reported a stored key
    // as a failed save and the refresh below never ran.
    try {
      deps.llmCatalog.invalidate(credentialId);
    } catch (error) {
      deps.warn('LLM catalog cache invalidation could not be persisted', error);
    }
    // Not awaited, so the save answers at once. Caught, so a refresh that
    // fails offline is a warning rather than an unhandled rejection.
    deps.llmCatalog.refresh().catch((error: unknown) => {
      deps.warn('LLM catalog refresh after a key save failed', error);
    });
  }
  return result;
}
