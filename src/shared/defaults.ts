import type { Settings } from './types.js';

/**
 * Shipped defaults, exactly as listed in `docs/02-architecture.md` section 2.1
 * (FR-020, TC-030). Kept in `shared` so tests can assert against them without
 * importing Electron.
 */

export const DEFAULT_CONSENT_REMINDER_TEXT =
  'Interview CoPilot is running and will show you private cues during this session. ' +
  'Telling your interviewer that you use an accessibility aid is your call and your ' +
  'responsibility. A text transcript of this session is saved on this computer as an ' +
  'unencrypted local file and is kept until you delete it. No audio is ever saved.';

export const SETTINGS_LIMITS = {
  overlayOpacity: { min: 0.3, max: 1.0 },
  overlayFontSizePx: { min: 16, max: 32 },
  turnEndGapMs: { min: 500, max: 1500 },
} as const;

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
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
    overlayWindow: { x: null, y: null, displayId: null },
    firstRun: { modelDownloaded: false },
  };
}
