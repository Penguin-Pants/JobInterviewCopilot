/**
 * LLM adapter registration (TASK-032).
 *
 * The one place an LLM provider id is bound to an adapter. Adding a provider is
 * a registry entry, an adapter file and one line here; nothing outside this
 * directory changes (FR-037).
 */
import type { CredentialId } from '../../../shared/types.js';
import { registerLlmProvider } from '../llm.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAiLlmProvider } from './openai.js';

/** Reads a credential out of the vault at request time, never a cached copy. */
export type KeyLookup = (credentialId: CredentialId) => string | undefined;

/** Register every v1 LLM adapter. Pure: it opens no connection (FR-070, FR-071). */
export function registerAllLlmProviders(keyFor: KeyLookup): void {
  registerLlmProvider(createAnthropicProvider({ keyFor: () => keyFor('anthropic') }));
  registerLlmProvider(createOpenAiLlmProvider({ keyFor: () => keyFor('openai') }));
}
