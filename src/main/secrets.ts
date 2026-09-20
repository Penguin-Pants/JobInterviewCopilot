import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { redact } from './logger.js';
import type { CredentialId, SecretStatus, SecretVault, ValidationResult } from '../shared/types.js';

/**
 * The API key vault (CMP-02, FR-021, FR-022, FR-026, NFR-003).
 *
 * Keys are encrypted with Electron safeStorage, which is DPAPI-backed on
 * Windows, and written to secrets.bin. They never touch settings.json, never
 * cross IPC and never reach a renderer: `status()` returns booleans only.
 *
 * There is no plaintext fallback. If encryption is unavailable the vault
 * refuses to save (FR-022). That is deliberate: a silent downgrade to plaintext
 * would be worse than a visible failure.
 */

export const CREDENTIAL_IDS: readonly CredentialId[] = [
  'deepgram',
  'openai',
  'anthropic',
  'elevenlabs',
] as const;

type SecretKeyField = Exclude<keyof SecretVault, 'credentialVersions'>;
const VAULT_FIELD: Record<CredentialId, SecretKeyField> = {
  deepgram: 'deepgramApiKey',
  openai: 'openaiApiKey',
  anthropic: 'anthropicApiKey',
  elevenlabs: 'elevenlabsApiKey',
};

/**
 * The bits of Electron safeStorage this module needs, injected so the vault can
 * be tested without an Electron runtime and so the unavailable case is testable.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Validates a key against its provider before it is saved (FR-026). */
export type KeyValidator = (credentialId: CredentialId, key: string) => Promise<ValidationResult>;

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'Windows credential encryption is unavailable, so API keys cannot be stored. ' +
        'Interview Copilot will not fall back to storing keys in plain text (FR-022).',
    );
    this.name = 'EncryptionUnavailableError';
  }
}

export interface SecretVaultStoreOptions {
  /** Directory holding secrets.bin. Injected so tests never touch real userData. */
  dir: string;
  safeStorage: SafeStorageLike;
}

export class SecretVaultStore {
  private readonly dir: string;
  private readonly safeStorage: SafeStorageLike;

  constructor(options: SecretVaultStoreOptions) {
    this.dir = options.dir;
    this.safeStorage = options.safeStorage;
    mkdirSync(this.dir, { recursive: true });
  }

  /** secrets.bin, deliberately a different file from settings.json (FR-021). */
  get file(): string {
    return join(this.dir, 'secrets.bin');
  }

  private read(): SecretVault {
    if (!existsSync(this.file)) return {};
    if (!this.safeStorage.isEncryptionAvailable()) throw new EncryptionUnavailableError();
    try {
      const plain = this.safeStorage.decryptString(readFileSync(this.file));
      const parsed: unknown = JSON.parse(plain);
      // Arrays pass a naive typeof-object check, and assigning a named property
      // to one is silently dropped by JSON.stringify: set() would report
      // success while storing nothing and status() would stay false. Only a
      // plain record is a vault.
      const isPlainRecord = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      return isPlainRecord ? (parsed as SecretVault) : {};
    } catch {
      // An unreadable vault is treated as empty. The user re-enters their keys.
      // The file is left alone rather than deleted, so nothing is destroyed.
      return {};
    }
  }

  private write(vault: SecretVault): void {
    if (!this.safeStorage.isEncryptionAvailable()) throw new EncryptionUnavailableError();
    const ciphertext = this.safeStorage.encryptString(JSON.stringify(vault));
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, ciphertext);
    renameSync(tmp, this.file);
  }

  /**
   * Which credentials are present. Booleans only: this is the only
   * secret-shaped value a renderer is ever given (FR-022, TC-022).
   */
  status(): SecretStatus {
    let vault: SecretVault = {};
    try {
      vault = this.read();
    } catch {
      // Encryption unavailable means nothing is readable, so nothing is present.
    }
    return {
      deepgram: Boolean(vault.deepgramApiKey),
      openai: Boolean(vault.openaiApiKey),
      anthropic: Boolean(vault.anthropicApiKey),
      elevenlabs: Boolean(vault.elevenlabsApiKey),
    };
  }

  /**
   * Validate a key live, then save it only if validation passed (FR-026).
   * A failed validation writes nothing and returns the provider's reason.
   *
   * The reason is masked before it is returned. It comes from a provider error
   * and crosses IPC to a renderer, and providers do echo the rejected
   * credential back in their error bodies. Logger redaction cannot help here,
   * because this value never goes through the logger (FR-034, NFR-003).
   */
  async set(
    credentialId: CredentialId,
    key: string,
    validate: KeyValidator,
  ): Promise<ValidationResult> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { ok: false, reason: new EncryptionUnavailableError().message };
    }

    const result = await validate(credentialId, key);
    if (!result.ok) {
      return {
        ok: false,
        ...(result.reason === undefined ? {} : { reason: redact(result.reason) as string }),
      };
    }

    const vault = this.read();
    vault[VAULT_FIELD[credentialId]] = key;
    vault.credentialVersions = { ...vault.credentialVersions, [credentialId]: randomUUID() };
    this.write(vault);
    return { ok: true };
  }

  /**
   * Read one key for main-process use only. Never exposed over IPC.
   * Returns undefined rather than throwing when the vault cannot be opened.
   */
  peek(credentialId: CredentialId): string | undefined {
    try {
      return this.read()[VAULT_FIELD[credentialId]];
    } catch {
      return undefined;
    }
  }

  /** Opaque rotation marker used to reject catalogs written for an older key. */
  version(credentialId: CredentialId): string | undefined {
    try {
      return this.read().credentialVersions?.[credentialId];
    } catch {
      return undefined;
    }
  }

  /** Remove one credential. Used when a user clears a key. */
  clear(credentialId: CredentialId): void {
    const vault = this.read();
    delete vault[VAULT_FIELD[credentialId]];
    if (vault.credentialVersions) delete vault.credentialVersions[credentialId];
    this.write(vault);
  }
}
