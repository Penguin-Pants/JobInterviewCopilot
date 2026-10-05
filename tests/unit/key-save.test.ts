/**
 * TC-196, the save that starts a credential replacement (FR-026, FR-117).
 *
 * The other half of `TC-196`, in `stt-catalog.test.ts`, proves an invalidated
 * catalog cannot be repopulated by a discovery started with the old key. This
 * half proves a validated `secrets:set` is what invalidates it. The handler
 * used to live in `src/main/index.ts`, which a test cannot import, so nothing
 * pinned the call and removing it would have passed every suite.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { saveProviderKey, type KeySaveDeps } from '../../src/main/key-save.js';
import type { KeyValidator } from '../../src/main/secrets.js';
import type { CredentialId, ValidationResult } from '../../src/shared/types.js';

interface Script {
  /** What the vault answers, after validation. */
  result?: ValidationResult;
  servesLlm?: boolean;
  sttThrows?: boolean;
  llmThrows?: boolean;
  healthThrows?: boolean;
  refreshRejects?: boolean;
}

function harness(script: Script = {}) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const validate: KeyValidator = () => Promise.resolve({ ok: true });
  const set = vi.fn((credentialId: CredentialId) => {
    calls.push(`vault.set:${credentialId}`);
    return Promise.resolve(script.result ?? { ok: true });
  });
  const deps: KeySaveDeps = {
    vault: { set },
    validate,
    sttCatalog: {
      invalidate: (credentialId) => {
        calls.push(`stt.invalidate:${credentialId}`);
        if (script.sttThrows) throw new Error('EPERM: stt-catalog.json is locked');
      },
    },
    llmCatalog: {
      invalidate: (provider) => {
        calls.push(`llm.invalidate:${provider}`);
        if (script.llmThrows) throw new Error('EPERM: llm-catalog.json is locked');
      },
      refresh: () => {
        calls.push('llm.refresh');
        return script.refreshRejects ? Promise.reject(new Error('offline')) : Promise.resolve();
      },
    },
    health: {
      noteKeySaved: (credentialId) => {
        calls.push(`health.noteKeySaved:${credentialId}`);
        if (script.healthThrows) throw new Error('health registry is not bound');
      },
    },
    servesLlm: () => script.servesLlm ?? true,
    warn: (message) => warnings.push(message),
  };
  return { deps, calls, warnings, set, validate };
}

const EVERY_STEP = [
  'vault.set:openai',
  'stt.invalidate:openai',
  'health.noteKeySaved:openai',
  'llm.invalidate:openai',
  'llm.refresh',
];

describe('TC-196 a validated key save invalidates what the old key produced', () => {
  it('retires both catalogs and clears health for a key that serves both', async () => {
    const { deps, calls, set, validate } = harness();

    await expect(saveProviderKey(deps, 'openai', 'sk-new')).resolves.toEqual({ ok: true });

    // Validated with the injected check, so FR-026's deadline is the one applied.
    expect(set).toHaveBeenCalledWith('openai', 'sk-new', validate);
    // The LLM entry is invalidated before the refresh that replaces it.
    expect(calls).toEqual(EVERY_STEP);
  });

  it('leaves the language-model catalog alone for a speech-only credential', async () => {
    const { deps, calls } = harness({ servesLlm: false });

    await saveProviderKey(deps, 'deepgram', 'dg-new');

    expect(calls).toEqual([
      'vault.set:deepgram',
      'stt.invalidate:deepgram',
      'health.noteKeySaved:deepgram',
    ]);
  });

  it('changes nothing when the key fails validation', async () => {
    const refused: ValidationResult = { ok: false, reason: 'The key was rejected.' };
    const { deps, calls } = harness({ result: refused });

    await expect(saveProviderKey(deps, 'openai', 'sk-bad')).resolves.toEqual(refused);

    // A key that was never saved leaves every catalog and CONFIG_REQUIRED as they were.
    expect(calls).toEqual(['vault.set:openai']);
  });

  it('reports a stored key as saved when a catalog cannot persist its invalidation', async () => {
    const { deps, calls, warnings } = harness({ sttThrows: true, llmThrows: true });

    // The key is already in the vault. Reporting a failure would tell the user
    // to retry a save that succeeded, and skip the steps after the throw.
    await expect(saveProviderKey(deps, 'openai', 'sk-new')).resolves.toEqual({ ok: true });

    expect(calls).toEqual(EVERY_STEP);
    expect(warnings).toEqual([
      'STT catalog cache invalidation could not be persisted',
      'LLM catalog cache invalidation could not be persisted',
    ]);
  });

  it('reports a stored key as saved when health cannot take the news, and still refreshes', async () => {
    const { deps, calls, warnings } = harness({ healthThrows: true });

    await expect(saveProviderKey(deps, 'openai', 'sk-new')).resolves.toEqual({ ok: true });

    expect(calls).toEqual(EVERY_STEP);
    expect(warnings).toEqual(['provider health could not note the saved key']);
  });

  it('a failed background refresh is warned about, not left unhandled', async () => {
    const { deps, warnings } = harness({ refreshRejects: true });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(saveProviderKey(deps, 'openai', 'sk-new')).resolves.toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(warnings).toEqual(['LLM catalog refresh after a key save failed']);
  });

  /** Pinned from source, because `index.ts` cannot be imported by a test. */
  it('is what the secrets:set handler runs', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const handler = source.slice(source.indexOf("router.handle('secrets:set'"));

    expect(handler.slice(0, 120)).toContain('saveProviderKey(keySaveDeps(), provider, key)');
  });
});
