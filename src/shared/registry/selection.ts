/**
 * The selection rules the Dashboard enforces (TASK-042).
 *
 * Pure and registry-driven. They live in `shared` rather than in the renderer
 * for two reasons: `src/renderer/**` is verified by E2E only, and every rule
 * here is a sentence from `01-requirements.md` that must not be re-stated in
 * JSX where it cannot be unit tested. Nothing here names a provider or a model
 * (FR-037, ADR-022, TC-057).
 */
import type {
  LlmModelDescriptor,
  ProviderChoice,
  ProviderDescriptor,
  SttModelDescriptor,
} from '../types.js';
import { LLM_REGISTRY } from './llm.js';
import { latencyBudgetFor, STREAMING_BUDGET, STT_REGISTRY } from './stt.js';

/**
 * Why a backup selection is refused, or `null` when it is allowed (FR-025).
 *
 * A different model from the same provider is not a backup: the credential and
 * the service are the same, so the failure that took the primary out takes the
 * backup with it. The Dashboard must prevent the selection, so this returns the
 * sentence it shows rather than a bare boolean.
 */
export function backupConflict(
  primary: ProviderChoice,
  backup: ProviderChoice | null,
  providerDisplayName: (providerId: string) => string,
): string | null {
  if (!backup) return null;
  if (backup.providerId !== primary.providerId) return null;
  const name = providerDisplayName(primary.providerId);
  return (
    `${name} is already the primary. A different model from the same provider is not a ` +
    'backup, because the credential and the service are the same.'
  );
}

/**
 * The `NFR-017` consequence of a non-streaming STT model, or `null` for a
 * streaming one (FR-038, FR-049, NFR-017).
 *
 * The budget and the accuracy text both come from the registry entry, so a new
 * non-streaming model gets the right sentence with no change here, and no
 * renderer names a model (TC-057).
 */
export function latencyConsequence(model: SttModelDescriptor): string | null {
  if (model.streaming) return null;
  const budget = latencyBudgetFor(model);
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  const parts = [
    `${model.displayName} does not stream. Turn end to first bullet is held to ` +
      `${budget.requirementId}, p50 under ${seconds(budget.p50Ms)} and p95 under ` +
      `${seconds(budget.p95Ms)}, instead of the ${seconds(STREAMING_BUDGET.p50Ms)} and ` +
      `${seconds(STREAMING_BUDGET.p95Ms)} a streaming model is held to.`,
  ];
  if (model.badge) parts.push(model.badge);
  return parts.join(' ');
}

/**
 * The pairs of display names behind one shared credential, speech first
 * (ADR-017, FR-025).
 *
 * Matched on `credentialId`, never on a provider name, so the Dashboard
 * sentence stays true when a second provider starts serving both capabilities.
 *
 * Private, because `sharedCredentialNotice` is the only thing the Dashboard
 * needs and an exported "which providers are shared" helper was called by
 * nothing but its own tests. Those tests then proved the shared-credential
 * rules about a function no window renders, which reads as coverage and is
 * not: the assertions are on the notice itself now.
 */
function sharedCredentialPairs(
  stt: ProviderDescriptor<SttModelDescriptor>[],
  llm: ProviderDescriptor<LlmModelDescriptor>[],
): { sttName: string; llmName: string }[] {
  const pairs: { sttName: string; llmName: string }[] = [];
  for (const speech of stt) {
    const language = llm.find((p) => p.credentialId === speech.credentialId);
    if (language) pairs.push({ sttName: speech.displayName, llmName: language.displayName });
  }
  return pairs;
}

/**
 * The sentence Provider Setup shows about shared credentials (FR-025, ADR-017).
 *
 * Empty when no provider serves both capabilities, so the Dashboard renders
 * nothing rather than a sentence about a situation that does not exist.
 */
export function sharedCredentialNotice(
  stt: ProviderDescriptor<SttModelDescriptor>[] = STT_REGISTRY,
  llm: ProviderDescriptor<LlmModelDescriptor>[] = LLM_REGISTRY,
): string {
  // Both halves are named from their own descriptor. Reusing the speech
  // provider's display name for the language half is right only while the two
  // descriptors sharing a credential happen to be named the same, which is
  // exactly the assumption this function's TSDoc promises not to make.
  return sharedCredentialPairs(stt, llm)
    .map(
      ({ sttName, llmName }) =>
        `One ${sttName} key serves ${sttName} speech-to-text models and ${llmName} language ` +
        'models alike. Enter it once. Deleting it takes both away.',
    )
    .join(' ');
}
