/**
 * TC-107. The transcript writer's input type cannot express audio.
 *
 * A runtime check could only prove that today's callers pass text. The claim is
 * about the type, so it is asserted against the type: no variant of
 * `TranscriptEntry` has a field a PCM buffer could be assigned to (FR-101,
 * NFR-002, ADR-019).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TranscriptEntry } from '../../src/shared/types.js';
import type { TranscriptEntryInput } from '../../src/main/session.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every field of every variant, as a union of its value types. */
type FieldTypes<T> = T extends unknown ? T[keyof T] : never;
type EntryFieldTypes = FieldTypes<TranscriptEntry>;

describe('TC-107 the writer cannot take audio', () => {
  it('no field of any variant accepts a binary buffer', () => {
    expectTypeOf<ArrayBuffer>().not.toExtend<EntryFieldTypes>();
    expectTypeOf<Uint8Array>().not.toExtend<EntryFieldTypes>();
    expectTypeOf<SharedArrayBuffer>().not.toExtend<EntryFieldTypes>();
    expectTypeOf<Blob>().not.toExtend<EntryFieldTypes>();
  });

  it('every field is a string, a number or an array of strings', () => {
    expectTypeOf<EntryFieldTypes>().toExtend<string | number | string[]>();
  });

  it('the append input is the same shape, minus the seq the manager assigns', () => {
    expectTypeOf<FieldTypes<TranscriptEntryInput>>().toExtend<string | number | string[]>();
    expectTypeOf<TranscriptEntryInput>().not.toHaveProperty('seq');
  });

  /**
   * The type is the guarantee, so the type must stay closed. A later edit
   * adding `audio?: Buffer` would pass the assertions above only by changing
   * them, which is visible in review; this catches the case where the entry
   * type grows a field nobody looked at.
   */
  it('the declared fields are exactly the ones section 2.5 lists', () => {
    const source = readFileSync(join(repoRoot, 'src', 'shared', 'types.ts'), 'utf8');
    const start = source.indexOf('export type TranscriptEntry');
    const body = source.slice(start, source.indexOf('\n\n', start));
    // Both variants, however they are formatted: one is written inline with
    // semicolons, the other across lines.
    const fields = [...body.matchAll(/\b(\w+)\??:/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'seq');

    expect(new Set(fields)).toEqual(
      new Set([
        'kind',
        'source',
        'text',
        'at',
        'forQuestion',
        'bullets',
        'model',
        'providerId',
        'status',
      ]),
    );
  });
});
