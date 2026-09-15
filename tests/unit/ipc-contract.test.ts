import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  audioWorkerChannels,
  invokeChannels,
  isIpcError,
  pushChannels,
  type InvokePayload,
  type InvokeResponse,
} from '../../src/shared/ipc.js';
import type { Settings } from '../../src/shared/types.js';

/** TC-002: a payload failing its schema is rejected, not forwarded. */
describe('TC-002 payload validation', () => {
  it('rejects a malformed payload on a typical channel', () => {
    const schema = invokeChannels['profile:create'].payload;
    expect(schema.safeParse({ name: '' }).success).toBe(false);
    expect(schema.safeParse({ nope: 1 }).success).toBe(false);
    expect(schema.safeParse({ name: 'Acme' }).success).toBe(true);
  });

  it('rejects a hotkey rebind for an unknown action', () => {
    const schema = invokeChannels['hotkey:rebind'].payload;
    expect(schema.safeParse({ action: 'launchMissiles', accelerator: 'F1' }).success).toBe(false);
    expect(schema.safeParse({ action: 'togglePause', accelerator: 'F1' }).success).toBe(true);
  });

  it('every declared channel has both a payload and a response schema', () => {
    for (const [name, spec] of Object.entries(invokeChannels)) {
      expect(spec.payload, `${name} payload`).toBeDefined();
      expect(spec.response, `${name} response`).toBeDefined();
      expect(spec.id, `${name} id`).toMatch(/^CH-\d{3}$/);
    }
    for (const [name, spec] of Object.entries(pushChannels)) {
      expect(spec.payload, `${name} payload`).toBeDefined();
      expect(spec.id, `${name} id`).toMatch(/^CH-\d{3}$/);
    }
  });

  it('channel ids are unique across all three tables', () => {
    const ids = [
      ...Object.values(invokeChannels).map((s) => s.id),
      ...Object.values(pushChannels).map((s) => s.id),
      ...Object.values(audioWorkerChannels).map((s) => s.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('isIpcError distinguishes a rejection from a real response', () => {
    expect(isIpcError({ __ipcError: true, channel: 'config:get', message: 'x' })).toBe(true);
    expect(isIpcError({ ok: true })).toBe(false);
    expect(isIpcError(null)).toBe(false);
  });
});

/**
 * TC-003: the bridge and the handlers share one type per channel.
 * A type-level test, so a drift between the two sides fails the build.
 */
describe('TC-003 contract types', () => {
  it('payload and response types are derived from the same declarations', () => {
    expectTypeOf<InvokeResponse<'config:get'>>().toExtend<Settings>();
    expectTypeOf<InvokePayload<'profile:create'>>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<InvokePayload<'overlay:setInteractive'>>().toEqualTypeOf<{
      interactive: boolean;
    }>();
  });

  it('the settings schema and the Settings type agree on shape', () => {
    const parsed = invokeChannels['config:get'].response.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

/**
 * Every channel documented in the architecture must exist in code.
 * This is what stops the contract and the document drifting apart.
 */
describe('IPC contract matches the architecture document', () => {
  it('declares every CH- id listed in docs/02-architecture.md section 4', () => {
    const doc = readFileSync('docs/02-architecture.md', 'utf8');
    const section = doc.slice(
      doc.indexOf('## 4. IPC contract'),
      doc.indexOf('## 5. Critical sequences'),
    );
    const documented = new Set<string>(section.match(/CH-\d{3}/g) ?? []);

    const implemented = new Set<string>([
      ...Object.values(invokeChannels).map((s) => s.id),
      ...Object.values(pushChannels).map((s) => s.id),
      ...Object.values(audioWorkerChannels).map((s) => s.id),
    ]);

    const missing = [...documented].filter((id) => !implemented.has(id));
    expect(missing, `documented but not implemented: ${missing.join(', ')}`).toEqual([]);
  });
});
