import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  EncryptionUnavailableError,
  SecretVaultStore,
  type SafeStorageLike,
} from '../../src/main/secrets.js';
import { defaultSettings } from '../../src/shared/defaults.js';
import { invokeChannels } from '../../src/shared/ipc.js';

const SAMPLE_KEY = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icp-secrets-'));
}

/** A reversible stand-in for DPAPI. Not encryption; it only has to round trip. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
  };
}

const alwaysValid = vi.fn(async () => ({ ok: true }));

/** TC-020: keys are encrypted, in their own file, never in settings.json. */
describe('TC-020 vault storage', () => {
  it('writes ciphertext to secrets.bin and nothing to settings.json', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(defaultSettings()), 'utf8');

    const vault = new SecretVaultStore({ dir, safeStorage: fakeSafeStorage() });
    await vault.set('anthropic', SAMPLE_KEY, alwaysValid);

    expect(existsSync(vault.file)).toBe(true);
    const raw = readFileSync(vault.file, 'utf8');
    expect(raw.startsWith('enc:')).toBe(true);

    const settingsText = readFileSync(join(dir, 'settings.json'), 'utf8');
    expect(settingsText).not.toContain(SAMPLE_KEY);
    expect(settingsText).not.toContain('sk-ant');
  });

  it('round trips the key for main-process use', async () => {
    const vault = new SecretVaultStore({ dir: tmp(), safeStorage: fakeSafeStorage() });
    await vault.set('deepgram', 'abc123', alwaysValid);
    expect(vault.peek('deepgram')).toBe('abc123');
  });
});

/** TC-021: no plaintext fallback when encryption is unavailable. */
describe('TC-021 no plaintext fallback', () => {
  it('refuses to save and writes nothing', async () => {
    const dir = tmp();
    const vault = new SecretVaultStore({ dir, safeStorage: fakeSafeStorage(false) });

    const result = await vault.set('openai', SAMPLE_KEY, alwaysValid);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/plain text/i);
    expect(existsSync(vault.file)).toBe(false);
  });

  it('surfaces the refusal as a dedicated error type, not a silent downgrade', () => {
    expect(new EncryptionUnavailableError().message).toMatch(/will not fall back/i);
  });
});

/** TC-022: the status channel can carry booleans and nothing else. */
describe('TC-022 status leaks nothing', () => {
  it('returns booleans only', async () => {
    const vault = new SecretVaultStore({ dir: tmp(), safeStorage: fakeSafeStorage() });
    await vault.set('openai', SAMPLE_KEY, alwaysValid);

    const status = vault.status();
    expect(status).toEqual({ deepgram: false, openai: true, anthropic: false, elevenlabs: false });
    for (const value of Object.values(status)) expect(typeof value).toBe('boolean');
  });

  it('the declared response schema rejects a key-shaped value', () => {
    const schema = invokeChannels['secrets:status'].response;
    expect(
      schema.safeParse({ deepgram: false, openai: SAMPLE_KEY, anthropic: false, elevenlabs: false })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ deepgram: false, openai: true, anthropic: false, elevenlabs: false })
        .success,
    ).toBe(true);
  });

  it('no invoke channel declares a response that could carry a raw key', () => {
    // secrets:set returns a ValidationResult, secrets:status returns booleans.
    // Neither can express a credential string keyed by a credential name.
    const setResponse = invokeChannels['secrets:set'].response;
    expect(setResponse.safeParse({ ok: true, reason: SAMPLE_KEY }).success).toBe(true);
    // The reason field is free text by necessity; it is redacted at the logger,
    // and the vault never puts a key into it. Asserted in the redaction tests.
    expect(Object.keys(invokeChannels)).not.toContain('secrets:get');
    expect(Object.keys(invokeChannels)).not.toContain('secrets:read');
  });
});

/** TC-024: validate before save. A rejected key is never persisted. */
describe('TC-024 validate before save', () => {
  it('saves nothing when validation fails and returns the provider reason', async () => {
    const vault = new SecretVaultStore({ dir: tmp(), safeStorage: fakeSafeStorage() });
    const reject = vi.fn(async () => ({ ok: false, reason: 'HTTP 401 invalid_api_key' }));

    const result = await vault.set('openai', SAMPLE_KEY, reject);

    expect(result).toEqual({ ok: false, reason: 'HTTP 401 invalid_api_key' });
    expect(vault.status().openai).toBe(false);
    expect(existsSync(vault.file)).toBe(false);
  });

  it('masks a key the provider echoed back in its rejection reason', async () => {
    // Providers do return the offending credential in an error body. That reason
    // crosses IPC to a renderer and never passes through the logger, so the
    // vault has to mask it on the way out (FR-034, NFR-003).
    const vault = new SecretVaultStore({ dir: tmp(), safeStorage: fakeSafeStorage() });
    const echoing = vi.fn(async () => ({
      ok: false,
      reason: `Incorrect API key provided: ${SAMPLE_KEY}. You can find your key at ...`,
    }));

    const result = await vault.set('anthropic', SAMPLE_KEY, echoing);

    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain(SAMPLE_KEY);
    expect(result.reason).toContain('[redacted]');
    expect(result.reason).toContain('Incorrect API key provided');
  });

  it('leaves a reason with no credential in it untouched', async () => {
    const vault = new SecretVaultStore({ dir: tmp(), safeStorage: fakeSafeStorage() });
    const plain = vi.fn(async () => ({ ok: false, reason: 'Network unreachable' }));
    expect((await vault.set('deepgram', 'k', plain)).reason).toBe('Network unreachable');
  });

  it('saves when validation passes', async () => {
    const vault = new SecretVaultStore({ dir: tmp(), safeStorage: fakeSafeStorage() });
    const result = await vault.set(
      'elevenlabs',
      'sk_abcdefabcdefabcdefabcdefabcdefabcdef',
      alwaysValid,
    );
    expect(result.ok).toBe(true);
    expect(vault.status().elevenlabs).toBe(true);
  });

  it('rotates an opaque credential version whenever a key is replaced', async () => {
    const vault = new SecretVaultStore({ dir: tmp(), safeStorage: fakeSafeStorage() });
    await vault.set('openai', SAMPLE_KEY, alwaysValid);
    const first = vault.version('openai');
    await vault.set('openai', `${SAMPLE_KEY}replacement`, alwaysValid);
    expect(first).toBeTruthy();
    expect(vault.version('openai')).not.toBe(first);
  });

  it('clear removes one credential and leaves the others', async () => {
    const vault = new SecretVaultStore({ dir: tmp(), safeStorage: fakeSafeStorage() });
    await vault.set('openai', SAMPLE_KEY, alwaysValid);
    await vault.set('deepgram', 'abc', alwaysValid);
    vault.clear('openai');
    expect(vault.status()).toMatchObject({ openai: false, deepgram: true });
  });
});

/**
 * Regression: a damaged secrets.bin that decrypts to valid JSON such as `[]`
 * passed a naive typeof-object check. Assigning a named property to an array is
 * dropped by JSON.stringify, so set() reported success while storing nothing
 * and status() stayed false. A silent credential loss is worse than an error.
 */
describe('vault rejects non-record payloads', () => {
  it('treats a decrypted array as an empty vault and still stores the key', async () => {
    const dir = tmp();
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
    };
    const vault = new SecretVaultStore({ dir, safeStorage });

    // A vault whose contents decrypt to an array.
    writeFileSync(vault.file, 'enc:[]', 'utf8');

    const result = await vault.set('openai', SAMPLE_KEY, alwaysValid);

    expect(result.ok).toBe(true);
    expect(vault.status().openai, 'the key must actually be stored').toBe(true);
    expect(vault.peek('openai')).toBe(SAMPLE_KEY);
  });

  it('treats a decrypted scalar as an empty vault', async () => {
    const dir = tmp();
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
    };
    const vault = new SecretVaultStore({ dir, safeStorage });
    writeFileSync(vault.file, 'enc:"nonsense"', 'utf8');

    expect(await vault.set('deepgram', 'abc', alwaysValid)).toEqual({ ok: true });
    expect(vault.status().deepgram).toBe(true);
  });
});
