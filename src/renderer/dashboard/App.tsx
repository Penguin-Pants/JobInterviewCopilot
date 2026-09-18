/**
 * The Dashboard (CMP-13, TASK-042).
 *
 * `FR-087`'s six sections, plus the Overlay and appearance section that holds
 * the settings `FR-029` requires and Reset Overlay (`FR-009`), and the header
 * that carries the explicit Start and Stop controls `FR-088` requires and the
 * unambiguous statement of which profile is active (`FR-027`).
 *
 * Every control here is a native element, so Tab reaches it and Enter or Space
 * operates it without a key handler of its own (NFR-010, TC-124).
 */
import { useEffect, useState, type JSX } from 'react';
import { contrastRatio, parseHex } from '../../shared/color.js';
import { call } from './call.js';
import { CompanyProfiles } from './sections/CompanyProfiles.js';
import { ConsentReminder } from './sections/ConsentReminder.js';
import { CostAndUsage } from './sections/CostAndUsage.js';
import { Hotkeys } from './sections/Hotkeys.js';
import { OverlayAppearance } from './sections/OverlayAppearance.js';
import { ProviderSetup } from './sections/ProviderSetup.js';
import { SessionHistory } from './sections/SessionHistory.js';
import { useDashboardData } from './state.js';
import type { StreamState } from '../../shared/types.js';

/** What each refusal means in a sentence the user can act on (TC-104). */
const REFUSALS: Record<string, string> = {
  'session-active': 'A session is already running. Stop it before starting another.',
  'no-active-profile': 'No profile is active. Create or activate one first.',
  'stt-key-missing': 'The speech-to-text key is missing. Add it in Provider Setup.',
  'llm-key-missing': 'The language model key is missing. Add it in Provider Setup.',
};

/**
 * White, or the Dashboard's own dark text colour, whichever reads better on
 * the chosen accent. The accent is user-editable (Overlay and appearance),
 * so button text cannot assume white will always hold against it.
 */
function accentForeground(accentHex: string): string {
  const accent = parseHex(accentHex);
  if (!accent) return '#ffffff';
  const white = { r: 255, g: 255, b: 255 };
  const dark = { r: 22, g: 22, b: 26 }; // #16161a, this file's own --text.
  return contrastRatio(accent, white) >= contrastRatio(accent, dark) ? '#ffffff' : '#16161a';
}

function streamText(state: StreamState): string {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'starting':
      return 'starting';
    case 'running':
      return 'running';
    case 'error':
      return 'not captured';
  }
}

export function Dashboard(): JSX.Element {
  const data = useDashboardData();
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Two flags, not one. `session:start` pushes `state:session` active *before*
  // it awaits `live.start`, on purpose: the session is live the moment the
  // manager accepts it, and bringing capture and two sockets up takes long
  // enough that a Dashboard told afterwards would render it as inactive for the
  // whole of it. A single shared flag re-imposed exactly that, disabling Stop
  // over an already-running session until the start invoke returned, so a slow
  // permission prompt or a wedged socket left an interview with no way to stop
  // it (FR-088).
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  // FR-080: the Dashboard follows the theme mode setting. `system` leaves the
  // attribute off so the stylesheet falls through to `prefers-color-scheme`.
  useEffect(() => {
    const mode = data.settings?.theme.mode ?? 'system';
    const root = document.documentElement;
    if (mode === 'system') delete root.dataset.theme;
    else root.dataset.theme = mode;
    if (data.settings) {
      root.style.setProperty('--accent', data.settings.theme.accent);
      root.style.setProperty('--accent-foreground', accentForeground(data.settings.theme.accent));
    }
  }, [data.settings]);

  async function startSession(): Promise<void> {
    setSessionError(null);
    setStarting(true);
    const result = await call('session:start');
    setStarting(false);
    if (!result.ok) {
      setSessionError(result.message);
      return;
    }
    if ('refused' in result.value) {
      setSessionError(REFUSALS[result.value.refused] ?? result.value.message);
    }
  }

  async function stopSession(): Promise<void> {
    setSessionError(null);
    setStopping(true);
    const result = await call('session:stop');
    setStopping(false);
    if (!result.ok) setSessionError(result.message);
  }

  if (!data.settings) {
    // A failed `config:get` resolves with an `IpcError` rather than rejecting,
    // so without this branch the Dashboard sat on "Loading settings…" for the
    // life of the window with nothing said and nothing to press.
    return (
      <main data-testid="dashboard">
        <h1>Interview CoPilot</h1>
        {data.loadError ? (
          <>
            <p role="alert" data-testid="dashboard-load-error">
              {data.loadError}
            </p>
            <button
              type="button"
              data-testid="dashboard-retry"
              onClick={() => void data.reloadAll()}
            >
              Try again
            </button>
          </>
        ) : (
          <p data-testid="dashboard-loading">Loading settings…</p>
        )}
      </main>
    );
  }

  const activeName = data.activeProfile?.name ?? null;

  return (
    <main data-testid="dashboard">
      <header data-testid="dashboard-header">
        <h1>Interview CoPilot</h1>

        {data.loadError ? (
          <p role="alert" data-testid="dashboard-load-error">
            {data.loadError}{' '}
            <button
              type="button"
              data-testid="dashboard-retry"
              onClick={() => void data.reloadAll()}
            >
              Try again
            </button>
          </p>
        ) : null}

        <p data-testid="header-active-profile">
          {activeName
            ? `Active profile: ${activeName}. This is the only active profile.`
            : 'Active profile: none yet.'}
        </p>

        <p
          data-testid="header-session-state"
          data-session-active={data.session.active ? 'true' : 'false'}
        >
          {data.session.active
            ? `Session running in ${data.session.profileName ?? activeName ?? 'this profile'}${
                data.session.paused ? ', paused' : ''
              }.`
            : 'No session is running.'}
        </p>

        <button
          type="button"
          data-testid="start-session"
          disabled={starting || data.session.active}
          onClick={() => void startSession()}
        >
          Start Session
        </button>
        <button
          type="button"
          data-testid="stop-session"
          disabled={stopping || !data.session.active}
          onClick={() => void stopSession()}
        >
          Stop Session
        </button>

        {sessionError ? (
          <p role="alert" data-testid="session-error">
            {sessionError}
          </p>
        ) : null}

        {data.audio ? (
          <p data-testid="audio-state">
            Interviewer audio: {streamText(data.audio.interviewer)}. Your microphone:{' '}
            {streamText(data.audio.candidate)}.
          </p>
        ) : null}
      </header>

      <ProviderSetup
        settings={data.settings}
        secrets={data.secrets}
        providers={data.providers}
        sessionActive={data.session.active}
        sessionNotice={
          data.sessionNotice && data.sessionNotice.sessionId === data.session.sessionId
            ? data.sessionNotice.message
            : null
        }
        onSettingsChanged={data.reloadSettings}
        onSecretsChanged={data.reloadSecrets}
      />

      <CompanyProfiles
        profiles={data.profiles}
        activeProfileId={data.settings.activeProfileId}
        session={data.session}
        model={data.model}
        docProgress={data.docProgress}
        onProfilesChanged={data.reloadProfiles}
        onSettingsChanged={data.reloadSettings}
      />

      <SessionHistory profiles={data.profiles} sessionRevision={data.sessionRevision} />

      <Hotkeys settings={data.settings} onSettingsChanged={data.reloadSettings} />

      <CostAndUsage
        settings={data.settings}
        session={data.session}
        usage={data.usage}
        warnings={data.warnings}
        onSettingsChanged={data.reloadSettings}
      />

      <ConsentReminder settings={data.settings} onSettingsChanged={data.reloadSettings} />

      <OverlayAppearance
        settings={data.settings}
        captureNotice={data.captureNotice}
        platform={data.platform}
        onSettingsChanged={data.reloadSettings}
      />
    </main>
  );
}
