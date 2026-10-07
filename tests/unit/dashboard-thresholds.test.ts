/**
 * Audit regression: the Dashboard threshold inputs (FR-031).
 *
 * `Number('')` is `0`, and zero turns a threshold warning off. A field the user
 * cleared must be refused, so an empty field never turns a warning off on its own.
 */
import { describe, expect, it } from 'vitest';
import { parseThreshold } from '../../src/renderer/dashboard/thresholds.js';
import { SETTINGS_LIMITS } from '../../src/shared/defaults.js';

const range = SETTINGS_LIMITS.timeMinutes;

describe('parseThreshold', () => {
  it('refuses an empty field', () => {
    expect(parseThreshold('', range)).toBeNull();
  });

  it('refuses a field of only spaces', () => {
    expect(parseThreshold('   ', range)).toBeNull();
  });

  it('accepts zero the user typed, which turns the warning off', () => {
    expect(parseThreshold('0', range)).toBe(0);
  });

  it('accepts a value in the range', () => {
    expect(parseThreshold(' 45 ', range)).toBe(45);
  });

  it('refuses a value out of the range or not a number', () => {
    expect(parseThreshold(String(range.max + 1), range)).toBeNull();
    expect(parseThreshold('-1', range)).toBeNull();
    expect(parseThreshold('abc', range)).toBeNull();
  });
});
