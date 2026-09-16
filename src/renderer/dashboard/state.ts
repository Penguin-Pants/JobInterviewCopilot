/**
 * Dashboard state (CMP-13, TASK-042).
 *
 * The main process is the single source of truth (CMP-01). Nothing here keeps a
 * second copy of anything that can change behind its back: every value is
 * either the answer to an invoke or the last push received on its channel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PushPayload } from '../../shared/ipc.js';
import type { DocumentState, Profile, SecretStatus, Settings } from '../../shared/types.js';
import { call } from './call.js';
import { lastSeen } from './earlyPushes.js';

export type SessionState = PushPayload<'state:session'>;
export type UsageState = PushPayload<'state:usage'>;
export type ProvidersState = PushPayload<'state:providers'>;
export type AudioState = PushPayload<'state:audio'>;
export type ModelState = PushPayload<'model:download'>;
export type UsageWarning = PushPayload<'usage:warning'>;

export interface DocProgress {
  state: DocumentState;
  percent: number;
}

export interface DashboardData {
  settings: Settings | null;
  secrets: SecretStatus | null;
  profiles: Profile[];
  session: SessionState;
  usage: UsageState | null;
  providers: ProvidersState | null;
  audio: AudioState | null;
  model: ModelState | null;
  warnings: UsageWarning[];
  captureNotice: string | null;
  docProgress: Record<string, DocProgress>;
  activeProfile: Profile | null;
  /**
   * Why the last load failed, or null.
   *
   * `invoke` resolves with an `IpcError` rather than rejecting (CMP-10), so a
   * reload that only acts on the success branch renders a failure as "nothing
   * there": no settings became a permanent "Loading settings…", no profiles
   * became "there are no profiles yet", and no secret status became "not
   * saved" beside every key that was in fact saved.
   */
  loadError: string | null;
  reloadSettings: () => Promise<void>;
  reloadSecrets: () => Promise<void>;
  reloadProfiles: () => Promise<void>;
  reloadAll: () => Promise<void>;
}

const IDLE_SESSION: SessionState = {
  active: false,
  sessionId: null,
  profileName: null,
  startedAt: null,
  paused: false,
};

export function useDashboardData(): DashboardData {
  // Seeded from `earlyPushes`, which subscribed while the document was still
  // loading. The main process replays these channels once to a renderer that
  // has just loaded, and an effect can run after that replay has been sent.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [session, setSession] = useState<SessionState>(
    () => lastSeen('state:session') ?? IDLE_SESSION,
  );
  const [usage, setUsage] = useState<UsageState | null>(() => lastSeen('state:usage') ?? null);
  const [providers, setProviders] = useState<ProvidersState | null>(
    () => lastSeen('state:providers') ?? null,
  );
  const [audio, setAudio] = useState<AudioState | null>(() => lastSeen('state:audio') ?? null);
  const [model, setModel] = useState<ModelState | null>(() => lastSeen('model:download') ?? null);
  const [warnings, setWarnings] = useState<UsageWarning[]>([]);
  const [captureNotice, setCaptureNotice] = useState<string | null>(
    () => lastSeen('notice:captureFidelity')?.message ?? null,
  );
  const [docProgress, setDocProgress] = useState<Record<string, DocProgress>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const reloadSettings = useCallback(async () => {
    const result = await call('config:get');
    if (!result.ok) {
      setLoadError(`The settings could not be read. ${result.message}`);
      return;
    }
    setLoadError(null);
    setSettings(result.value);
  }, []);

  const reloadSecrets = useCallback(async () => {
    const result = await call('secrets:status');
    if (!result.ok) {
      // `secrets` stays null, and every section that reads it says "unknown"
      // rather than "not saved", which is a claim this failure cannot support.
      setLoadError(`Which keys are saved could not be read. ${result.message}`);
      return;
    }
    setSecrets(result.value);
  }, []);

  const reloadProfiles = useCallback(async () => {
    const result = await call('profile:list');
    if (!result.ok) {
      setLoadError(`The profile list could not be read. ${result.message}`);
      return;
    }
    setProfiles(result.value);
  }, []);

  const reloadAll = useCallback(async () => {
    // Profiles first, and awaited. `profile:list` answers only once the main
    // process has created the default profile, and creating it is also what
    // sets `activeProfileId`. Reading the settings first returned the
    // pre-bootstrap snapshot, so the header said no profile was active over a
    // profile that was.
    setLoadError(null);
    await reloadProfiles();
    await reloadSettings();
    await reloadSecrets();
  }, [reloadProfiles, reloadSettings, reloadSecrets]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    // Every subscription is torn down by the function it returns. A Dashboard
    // that is reloaded keeps the main-process listener alive otherwise, and the
    // second copy pushes into a tree that no longer exists.
    const off = [
      window.copilot.on('state:session', setSession),
      window.copilot.on('state:usage', setUsage),
      window.copilot.on('state:providers', setProviders),
      window.copilot.on('state:audio', setAudio),
      window.copilot.on('model:download', setModel),
      window.copilot.on('notice:captureFidelity', (p) => setCaptureNotice(p.message)),
      window.copilot.on('usage:warning', (w) =>
        // At most one of each per session (FR-103, FR-109), so a repeat within
        // one session is a main-process defect rather than something to stack
        // up on screen. Across sessions it is not a repeat at all, which is why
        // the list is cleared at every session boundary below: deduping for the
        // life of the window swallowed the second interview's warning and left
        // the first interview's numbers on screen.
        setWarnings((current) =>
          current.some((existing) => existing.kind === w.kind) ? current : [...current, w],
        ),
      ),
      window.copilot.on('rag:progress', (p) =>
        setDocProgress((current) => ({
          ...current,
          [p.docId]: { state: p.state, percent: p.percent },
        })),
      ),
    ];
    // A push that landed between the `useState` initializers above and this
    // subscription is in the early buffer but not in React state. Re-seeding
    // once the subscription exists closes the remaining gap; after this point
    // nothing can arrive unobserved.
    const early = lastSeen('state:session');
    if (early) setSession(early);
    const earlyUsage = lastSeen('state:usage');
    if (earlyUsage) setUsage(earlyUsage);
    const earlyProviders = lastSeen('state:providers');
    if (earlyProviders) setProviders(earlyProviders);
    const earlyAudio = lastSeen('state:audio');
    if (earlyAudio) setAudio(earlyAudio);
    const earlyModel = lastSeen('model:download');
    if (earlyModel) setModel(earlyModel);
    const earlyNotice = lastSeen('notice:captureFidelity');
    if (earlyNotice) setCaptureNotice(earlyNotice.message);

    return () => off.forEach((unsubscribe) => unsubscribe());
  }, []);

  /**
   * A session boundary clears what belonged to the session that ended.
   *
   * `FR-103` and `FR-109` allow one warning of each kind **per session**. Held
   * for the life of the window, the first interview's warning suppressed the
   * second interview's and kept showing the first one's numbers. The live usage
   * is cleared on the same boundary, so a new session never shows the previous
   * one's timer and spend before its first `CH-204` tick lands. A session that
   * has *stopped* keeps its final numbers: they are the answer to "what did
   * that cost", and the panel says no session is running beside them.
   */
  const previousSessionId = useRef(session.sessionId);
  useEffect(() => {
    if (session.sessionId === previousSessionId.current) return;
    previousSessionId.current = session.sessionId;
    if (session.sessionId === null) return;
    setWarnings([]);
    setUsage(null);
  }, [session.sessionId]);

  // A document reaching `ready` or `error` has a record to read the state from,
  // so the profile list is the truth from then on and the progress entry would
  // only go stale. Reloaded here rather than polled.
  //
  // Keyed on *which* documents have settled, not on how many. A count is lossy:
  // one document settling while another goes back to `pending` in the same
  // batch leaves the count unchanged, and the settled document's real record,
  // its chunk count and its error text, was never read back.
  const settledSignature = Object.entries(docProgress)
    .filter(([, p]) => p.state === 'ready' || p.state === 'error')
    .map(([docId, p]) => `${docId}:${p.state}`)
    .sort()
    .join(',');
  const lastSettled = useRef(settledSignature);
  useEffect(() => {
    if (settledSignature === lastSettled.current) return;
    lastSettled.current = settledSignature;
    void reloadProfiles();
  }, [settledSignature, reloadProfiles]);

  // The session state carries the profile *name* for display. The active
  // profile itself is settings plus the profile list, so that the section that
  // has to disable a control during a session reads one value, not two.
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === settings?.activeProfileId) ?? null,
    [profiles, settings],
  );

  return {
    settings,
    secrets,
    profiles,
    session,
    usage,
    providers,
    audio,
    model,
    warnings,
    captureNotice,
    docProgress,
    activeProfile,
    loadError,
    reloadSettings,
    reloadSecrets,
    reloadProfiles,
    reloadAll,
  };
}
