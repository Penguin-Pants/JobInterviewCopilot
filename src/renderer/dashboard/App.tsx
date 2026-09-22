/**
 * The Dashboard (CMP-13, TASK-042).
 *
 * `FR-087`'s sections, plus the prompt editor and Overlay and appearance,
 * the settings `FR-029` requires and Reset Overlay (`FR-009`), are tabs behind
 * a sidebar rather than one long scrolling page, so no tab requires scrolling
 * the window to reach another. Hotkeys and Consent Reminder share one
 * "Preferences" tab, since both are small settings visited rarely; every other
 * section keeps its own tab. The header above the tabs carries the explicit
 * Start and Stop controls `FR-088` requires, the unambiguous statement of
 * which profile is active (`FR-027`), and the live session timer, spend and
 * threshold warnings, so that status stays visible whichever tab is open
 * rather than being missed on a tab the user is not looking at.
 *
 * A tab's content is hidden rather than unmounted when another tab is active,
 * so switching tabs never drops an unsaved draft (a provider selection, a
 * hotkey capture) or forces a section like Session History to re-fetch.
 *
 * Every control here is a native element, so Tab reaches it and Enter or Space
 * operates it without a key handler of its own (NFR-010, TC-124). The tab
 * list itself follows the ARIA tabs pattern: only the active tab sits in the
 * natural Tab order, and Up/Down/Home/End move and activate among the rest,
 * the way a native OS tab strip does.
 */
import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { contrastRatio, parseHex } from '../../shared/color.js';
import { call } from './call.js';
import { formatElapsed, formatUsd } from './format.js';
import { CompanyProfiles } from './sections/CompanyProfiles.js';
import { ConsentReminder } from './sections/ConsentReminder.js';
import { CostAndUsage } from './sections/CostAndUsage.js';
import { Hotkeys } from './sections/Hotkeys.js';
import { OverlayAppearance } from './sections/OverlayAppearance.js';
import { ProviderSetup } from './sections/ProviderSetup.js';
import { Prompts } from './sections/Prompts.js';
import { SessionHistory } from './sections/SessionHistory.js';
import { useDashboardData } from './state.js';
import type { StreamState } from '../../shared/types.js';

type TabId = 'profiles' | 'prompts' | 'history' | 'providers' | 'usage' | 'overlay' | 'preferences';

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'profiles', label: 'Company Profiles' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'history', label: 'Session History' },
  { id: 'providers', label: 'Provider Setup' },
  { id: 'usage', label: 'Cost and Usage' },
  { id: 'overlay', label: 'Overlay and appearance' },
  { id: 'preferences', label: 'Preferences' },
];

const brandIconUrl = new URL('../assets/logo-primary.svg', import.meta.url).href;

function BrandLockup(): JSX.Element {
  return (
    <div className="brand-lockup">
      <img src={brandIconUrl} alt="" width="44" height="44" />
      <div>
        <h1>Interview Copilot</h1>
        <p>You lead. Copilot supports.</p>
      </div>
    </div>
  );
}

/** What each refusal means in a sentence the user can act on (TC-104). */
const REFUSALS: Record<string, string> = {
  'session-active': 'A session is already running. Stop it before starting another.',
  'no-active-profile': 'No profile is active. Create or activate one first.',
  'stt-key-missing': 'The speech-to-text key is missing. Add it in Provider Setup.',
  'llm-key-missing': 'The language model key is missing. Add it in Provider Setup.',
};

/**
 * White or black, whichever reads better on the chosen accent. The accent is
 * user-editable (Overlay and appearance), so button text cannot assume white
 * will always hold against it.
 *
 * Pure black and pure white, not this file's own `--text` (`#16161a`).
 * Picking the higher-contrast of two *fixed* candidates only guarantees the
 * 4.5:1 target `App.tsx` owes the accent's text if the candidates sit at the
 * extremes: at the one background luminance where black and white give equal
 * contrast, that shared value works out to ~4.58:1, comfortably clearing the
 * target either way. `#16161a` is not that extreme, and a mid-grey accent
 * (around `#777777`) picked it while both candidates sat under 4.5:1: white
 * scored ~4.48:1, `#16161a` scored ~4.03:1, and "the better of two failing
 * options" was returned as if it had passed.
 */
function accentForeground(accentHex: string): string {
  const accent = parseHex(accentHex);
  if (!accent) return '#ffffff';
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  return contrastRatio(accent, white) >= contrastRatio(accent, black) ? '#ffffff' : '#000000';
}

/**
 * The sidebar tab list (NFR-010).
 *
 * A roving tabindex: only the active tab button is a Tab stop, and Up, Down,
 * Home and End move among the rest and activate immediately, the interaction
 * a native OS tab strip already has and the one WAI-ARIA's tabs pattern
 * expects for a `role="tablist"`.
 */
function TabNav({
  activeTab,
  onSelect,
}: {
  activeTab: TabId;
  onSelect: (id: TabId) => void;
}): JSX.Element {
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const index = TABS.findIndex((tab) => tab.id === activeTab);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % TABS.length;
        break;
      case 'ArrowUp':
        next = (index - 1 + TABS.length) % TABS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextId = TABS[next]?.id;
    if (!nextId) return;
    onSelect(nextId);
    // The button moving isn't the one focused yet: `onSelect` re-renders with
    // the new `tabIndex={0}` after this handler returns, so focusing it here
    // would move focus to a button not yet in the tab order.
    requestAnimationFrame(() => document.getElementById(`tab-${nextId}`)?.focus());
  }

  return (
    <nav
      data-testid="dashboard-sidebar"
      aria-label="Dashboard sections"
      role="tablist"
      aria-orientation="vertical"
      className="dashboard-sidebar"
      onKeyDown={onKeyDown}
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          id={`tab-${tab.id}`}
          data-testid={`tab-${tab.id}`}
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={`panel-${tab.id}`}
          tabIndex={activeTab === tab.id ? 0 : -1}
          className="dashboard-tab"
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
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
  const [activeTab, setActiveTab] = useState<TabId>('profiles');
  const [promptDirty, setPromptDirty] = useState(false);
  // Bumped to remount the prompt editor, which is how a confirmed discard
  // actually drops the draft rather than leaving it behind the hidden tab.
  const [promptEditorKey, setPromptEditorKey] = useState(0);
  const content = useRef<HTMLDivElement | null>(null);

  // All panels share this one scrolling element, so its scroll position
  // survives a tab switch on its own. Left alone, scrolling deep into a long
  // panel and then opening a shorter one opened it part-way down, or even
  // past its own content, with nothing of that tab on screen at all.
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [activeTab]);

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
        <BrandLockup />
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
        <BrandLockup />

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
          className="secondary-button"
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

        {/*
          The live timer, spend and threshold warnings live here rather than
          only inside the Cost and Usage tab, so a session running while the
          user is on a different tab is still visible without switching to
          check it. The rest of that section's detail (audio seconds, tokens,
          the price table version, the thresholds themselves) stays in its own
          tab, since it is not the kind of thing a glance needs.
        */}
        <p
          data-testid="header-live-usage"
          data-session-active={data.session.active ? 'true' : 'false'}
        >
          Session time:{' '}
          <span data-testid="live-timer">{formatElapsed(data.usage?.elapsedSeconds ?? 0)}</span>
          {' · '}
          Estimated spend:{' '}
          <span data-testid="live-spend">{formatUsd(data.usage?.estimatedUsd ?? 0)}</span>
        </p>

        {data.warnings.map((warning) => (
          <p role="alert" key={warning.kind} data-testid={`usage-warning-${warning.kind}`}>
            {warning.kind === 'cost'
              ? `Estimated spend has passed ${formatUsd(warning.threshold)} and is now ${formatUsd(warning.value)}.`
              : `This session has passed ${warning.threshold} minutes and is now ${Math.round(warning.value)} minutes long.`}{' '}
            The session is still running. This is a notice, not a stop.
          </p>
        ))}
      </header>

      <div className="dashboard-body">
        <TabNav
          activeTab={activeTab}
          onSelect={(id) => {
            if (
              activeTab === 'prompts' &&
              id !== 'prompts' &&
              promptDirty &&
              !window.confirm('Discard the unsaved prompt changes?')
            )
              return;
            if (activeTab === 'prompts' && id !== 'prompts' && promptDirty) {
              setPromptEditorKey((value) => value + 1);
            }
            setActiveTab(id);
          }}
        />

        <div className="dashboard-content" ref={content}>
          <div
            id="panel-profiles"
            role="tabpanel"
            aria-labelledby="tab-profiles"
            hidden={activeTab !== 'profiles'}
          >
            <CompanyProfiles
              profiles={data.profiles}
              activeProfileId={data.settings.activeProfileId}
              session={data.session}
              model={data.model}
              docProgress={data.docProgress}
              onProfilesChanged={data.reloadProfiles}
              onSettingsChanged={data.reloadSettings}
              settings={data.settings}
            />
          </div>

          <div
            id="panel-prompts"
            role="tabpanel"
            aria-labelledby="tab-prompts"
            hidden={activeTab !== 'prompts'}
          >
            <Prompts
              key={promptEditorKey}
              settings={data.settings}
              profiles={data.profiles}
              activeProfileId={data.settings.activeProfileId}
              onSettingsChanged={data.reloadSettings}
              onDirtyChange={setPromptDirty}
            />
          </div>

          <div
            id="panel-history"
            role="tabpanel"
            aria-labelledby="tab-history"
            hidden={activeTab !== 'history'}
          >
            <SessionHistory profiles={data.profiles} sessionRevision={data.sessionRevision} />
          </div>

          <div
            id="panel-providers"
            role="tabpanel"
            aria-labelledby="tab-providers"
            hidden={activeTab !== 'providers'}
          >
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
          </div>

          <div
            id="panel-usage"
            role="tabpanel"
            aria-labelledby="tab-usage"
            hidden={activeTab !== 'usage'}
          >
            <CostAndUsage
              settings={data.settings}
              session={data.session}
              usage={data.usage}
              onSettingsChanged={data.reloadSettings}
            />
          </div>

          <div
            id="panel-overlay"
            role="tabpanel"
            aria-labelledby="tab-overlay"
            hidden={activeTab !== 'overlay'}
          >
            <OverlayAppearance
              settings={data.settings}
              captureNotice={data.captureNotice}
              platform={data.platform}
              onSettingsChanged={data.reloadSettings}
            />
          </div>

          <div
            id="panel-preferences"
            role="tabpanel"
            aria-labelledby="tab-preferences"
            hidden={activeTab !== 'preferences'}
          >
            <Hotkeys settings={data.settings} onSettingsChanged={data.reloadSettings} />
            <ConsentReminder settings={data.settings} onSettingsChanged={data.reloadSettings} />
          </div>
        </div>
      </div>
    </main>
  );
}
