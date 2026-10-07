import { mkdtempSync, readFileSync as realReadFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `ProfileStore.recover` when `profile.json` exists but cannot be read (ADR-014).
 *
 * A read that fails with anything but ENOENT says nothing about what the file
 * holds: an antivirus lock or a permission change can hide a perfectly good
 * name. Root ignores file modes, so the failure is injected through `node:fs`.
 */

const blocked = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((path: string, ...rest: unknown[]) => {
      if (blocked.has(String(path))) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), {
          code: 'EACCES',
        });
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

const { ProfileStore } = await import('../../src/main/rag/store.js');

afterEach(() => blocked.clear());

describe('an index that exists but cannot be read', () => {
  it('lists the profile but never overwrites the unreadable file', () => {
    const store = new ProfileStore({
      userDataDir: mkdtempSync(join(tmpdir(), 'icp-store-')),
      dimensions: 8,
    });
    const profile = store.create('Acme Interview');
    const file = join(store.profileDir(profile.id), 'profile.json');
    blocked.add(file);

    expect(store.list().map((p) => p.id)).toEqual([profile.id]);
    // Writing the placeholder here replaced a name that was only hidden.
    expect(store.upsertDocument({ ...docFor(profile.id) })).toBeNull();

    blocked.clear();
    expect(JSON.parse(realReadFileSync(file, 'utf8')).name).toBe('Acme Interview');
    expect(store.get(profile.id)!.name).toBe('Acme Interview');
  });
});

function docFor(profileId: string) {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    profileId,
    originalFileName: 'a.md',
    originalPath: '',
    sourceFormat: 'md' as const,
    derivedMarkdownPath: null,
    docType: 'resume' as const,
    docTypeSource: 'auto' as const,
    contentHash: '',
    embeddingKey: '',
    chunkCount: 0,
    state: 'pending' as const,
    errorMessage: null,
    extractionQuality: 'native' as const,
    updatedAt: '',
  };
}
