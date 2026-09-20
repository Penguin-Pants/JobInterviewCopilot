import type { Settings } from './types.js';

/**
 * Shipped defaults, exactly as listed in `docs/02-architecture.md` section 2.1
 * (FR-020, TC-030). Kept in `shared` so tests can assert against them without
 * importing Electron.
 */

export const DEFAULT_CONSENT_REMINDER_TEXT =
  'Interview Copilot is running and will show you private cues during this session. ' +
  'Telling your interviewer that you use an accessibility aid is your call and your ' +
  'responsibility. A text transcript of this session is saved on this computer as an ' +
  'unencrypted local file and is kept until you delete it. No audio is ever saved.';

/**
 * The supported knowledge base ceiling (FR-068).
 *
 * A document at or below both numbers is queryable within 5 seconds of the file
 * system settling. Above either one the document is still processed and still
 * shows progress, but the 5-second target does not apply.
 *
 * Kept in `shared` because FR-068 requires the ceiling to be stated in the
 * Dashboard rather than only in a document, so the renderer reads these two
 * numbers instead of repeating them in a sentence that can drift.
 */
export const KB_CEILING = {
  maxBytes: 2 * 1024 * 1024,
  maxChunks: 200,
  /** The re-embed target the ceiling qualifies, in milliseconds (FR-068, TC-163). */
  reembedTargetMs: 5000,
} as const;

/**
 * The shipped overlay size, and the range the user may resize it to (FR-081).
 *
 * Kept in `shared` rather than beside the window code, because three parties
 * need the same numbers: the main process builds the window from them, the
 * settings store clamps a hand-edited file against them, and the overlay's own
 * resize grip has to stop where they stop.
 *
 * The minimum is the smallest box that still shows one suggestion card and the
 * dismiss button together. The maximum is a guard against a stored value that
 * would open the overlay larger than any display.
 */
export const OVERLAY_DEFAULT_SIZE = { width: 420, height: 260 } as const;

export const SETTINGS_LIMITS = {
  overlayOpacity: { min: 0.3, max: 1.0 },
  overlayFontSizePx: { min: 16, max: 32 },
  turnEndGapMs: { min: 500, max: 1500 },
  overlayWidthPx: { min: 320, max: 1600 },
  overlayHeightPx: { min: 180, max: 1200 },
} as const;

export function defaultSettings(): Settings {
  return {
    schemaVersion: 4,
    activeProfileId: '',
    providers: {
      stt: { primary: { providerId: 'deepgram', modelId: 'nova-3' }, backup: null },
      llm: {
        primary: { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
        backup: null,
      },
    },
    theme: {
      mode: 'system',
      accent: '#6366F1',
      overlayTranslucency: 'opacity',
      overlayOpacity: 0.85,
      overlayFontSizePx: 22,
    },
    hotkeys: {
      toggleInteraction: 'Control+Shift+I',
      togglePause: 'Control+Shift+P',
    },
    trigger: {
      turnEndGapMs: 800,
      minTurnWords: 3,
      minTurnChars: 12,
      candidateContextTurns: 2,
      candidateContextChars: 400,
    },
    thresholds: {
      costUsd: 2.0,
      timeMinutes: 60,
    },
    consentReminderText: DEFAULT_CONSENT_REMINDER_TEXT,
    overlayWindow: {
      x: null,
      y: null,
      width: null,
      height: null,
      displayId: null,
      clickThrough: true,
    },
    firstRun: { modelDownloaded: false },
  };
}
