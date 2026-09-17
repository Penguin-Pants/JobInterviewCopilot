import { AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { createRoot } from 'react-dom/client';
import { defaultSettings } from '../../shared/defaults.js';
import type { Settings } from '../../shared/types.js';
import { MAX_CARDS, reduceCards, shouldShowIdle } from './cards.js';
import { lastSeen } from './earlyPushes.js';
import { resolveOverlayTheme } from './theme.js';
import { ConsentReminder } from './components/ConsentReminder.js';
import { FontSizeControl } from './components/FontSizeControl.js';
import { IdleCard } from './components/IdleCard.js';
import { SuggestionCardView } from './components/SuggestionCardView.js';
import './styles.css';

/**
 * Teleprompter overlay (CMP-14, TASK-043).
 *
 * Traces FR-006, FR-007, FR-008, FR-076, FR-085, FR-089, FR-090, FR-091,
 * FR-092, FR-093, FR-094, FR-102, NFR-007, NFR-010, NFR-012.
 *
 * Two states and no third. Idle is the standing-by card; active is a stack of
 * at most three suggestion cards. **There is no error state in this component
 * tree, by design** (`FR-076`): the overlay's preload allowlist carries no
 * channel that could deliver one, `suggestion:end`'s three outcomes are all
 * things a card that already exists can be, and an extended silence is simply
 * the idle card (`FR-102`).
 *
 * Every piece of derived state is computed by a pure module: `cards.ts` owns
 * the stack and `theme.ts` owns the colours and the contrast floor, so the cap,
 * the ordering and `FR-093`'s 4.5 to 1 are driven in the unit suite rather than
 * only through a window.
 */

/** What the renderer knows about the host machine until `CH-216` says otherwise. */
const UNKNOWN_PLATFORM = { windowsBuild: 0, acrylicSupported: false };

function Overlay(): JSX.Element {
  // Every one of these is seeded from `earlyPushes`, because the main process
  // replays them all on `did-finish-load` and an effect can run after that
  // (FR-008). Missing the consent text in particular would mean this renderer
  // never reports ready and the suggestion gate never opens.
  const [consent, setConsent] = useState<string | null>(
    () => lastSeen('overlay:consent')?.text ?? null,
  );
  const [dismissed, setDismissed] = useState(false);
  const [interactive, setInteractive] = useState(
    () => lastSeen('overlay:mode')?.interactive ?? false,
  );
  const [paused, setPaused] = useState(
    () => lastSeen('overlay:mode')?.paused ?? lastSeen('state:session')?.paused ?? false,
  );
  const [sessionActive, setSessionActive] = useState(
    () => lastSeen('state:session')?.active ?? false,
  );
  const [captureNotice, setCaptureNotice] = useState<string | null>(
    () => lastSeen('notice:captureFidelity')?.message ?? null,
  );
  const [platform, setPlatform] = useState(() => lastSeen('notice:platform') ?? UNKNOWN_PLATFORM);
  // The shipped defaults until `CH-211` arrives, which is within a frame of the
  // load. Rendering nothing until then would mean the consent card, and so
  // `overlay:ready`, waited on the theme as well as on the text (ADR-016).
  const [theme, setTheme] = useState<Settings['theme']>(
    () => lastSeen('overlay:theme') ?? defaultSettings().theme,
  );
  const [cards, dispatch] = useReducer(reduceCards, []);
  const reported = useRef(false);

  /**
   * `prefers-reduced-motion` (NFR-010).
   *
   * The hook answers null where it cannot know, which is not the same as "no
   * preference", so the slide is enabled only on an explicit false. Treating
   * "don't know" as "no preference" would run the exact animation the
   * preference exists to prevent, on the first reveal, which is the one a user
   * who set it is most likely to notice.
   */
  const reduceMotion = useReducedMotion();
  const slide = reduceMotion === false;

  const prefersDark = useSystemPrefersDark();

  const resolved = useMemo(
    () => resolveOverlayTheme(theme, { prefersDark, acrylicSupported: platform.acrylicSupported }),
    [theme, prefersDark, platform.acrylicSupported],
  );

  useEffect(() => {
    const off = [
      window.copilot.on('overlay:consent', (p) => setConsent(p.text)),
      window.copilot.on('overlay:theme', (p) => setTheme(p)),
      window.copilot.on('notice:captureFidelity', (p) => setCaptureNotice(p.message)),
      window.copilot.on('notice:platform', (p) => setPlatform(p)),
      window.copilot.on('overlay:mode', (p) => {
        setInteractive(p.interactive);
        setPaused(p.paused);
      }),
      window.copilot.on('state:session', (p) => {
        setSessionActive(p.active);
        setPaused(p.paused);
      }),
      window.copilot.on('suggestion:begin', (payload) => dispatch({ kind: 'begin', payload })),
      window.copilot.on('suggestion:line', (payload) => dispatch({ kind: 'line', payload })),
      window.copilot.on('suggestion:end', (payload) => dispatch({ kind: 'end', payload })),
    ];

    // A push that landed between the `useState` initializers above and this
    // subscription is in the early buffer but not in React state. Re-seeding
    // once the subscription exists closes the remaining gap; after this point
    // nothing can arrive unobserved.
    const earlyConsent = lastSeen('overlay:consent');
    if (earlyConsent) setConsent(earlyConsent.text);
    const earlyTheme = lastSeen('overlay:theme');
    if (earlyTheme) setTheme(earlyTheme);
    const earlyMode = lastSeen('overlay:mode');
    if (earlyMode) {
      setInteractive(earlyMode.interactive);
      setPaused(earlyMode.paused);
    }
    const earlySession = lastSeen('state:session');
    if (earlySession) setSessionActive(earlySession.active);
    const earlyPlatform = lastSeen('notice:platform');
    if (earlyPlatform) setPlatform(earlyPlatform);
    const earlyNotice = lastSeen('notice:captureFidelity');
    if (earlyNotice) setCaptureNotice(earlyNotice.message);

    return () => off.forEach((unsubscribe) => unsubscribe());
  }, []);

  /**
   * A session boundary clears the stack and brings the reminder back (FR-006).
   *
   * `FR-006` says "before the first suggestion of **every** live session", so a
   * reminder dismissed during the last interview must not still be dismissed
   * for the next one. The main-process gate forgets its card at the same
   * boundary (ADR-036), so this is the renderer half of one rule rather than a
   * second opinion about it.
   *
   * Keyed on the transition into an active session, not on `active` itself: a
   * re-push of the same state is how crash recovery tells a renderer to look
   * again, and it must not wipe a card mid-interview.
   */
  const wasActive = useRef(false);
  useEffect(() => {
    if (sessionActive && !wasActive.current) {
      setDismissed(false);
      dispatch({ kind: 'reset' });
    }
    wasActive.current = sessionActive;
  }, [sessionActive]);

  /**
   * Report readiness only once the consent card is on screen (FR-008, ADR-016).
   *
   * This used to fire on mount, but the consent text arrives from the main
   * process and the card cannot exist yet at that point. Readiness would then
   * open the suggestion gate before the reminder had rendered, which is the one
   * thing the gate exists to prevent. Waiting for the text and then for a paint
   * makes "the reminder was shown" true when the main process is told so.
   */
  useEffect(() => {
    if (consent === null || reported.current) return;
    reported.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void window.copilot.invoke('overlay:ready');
      });
    });
  }, [consent]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    // The card is gone either way: `FR-006` is about the reminder being
    // dismissible, not about the main process knowing. The call is how the
    // session log can tell an acknowledged reminder from one left on screen.
    void window.copilot.invoke('consent:dismiss');
  }, []);

  const setFontSize = useCallback((px: number) => {
    // No optimistic update. The main process answers by pushing `overlay:theme`
    // back, so what is rendered is what was stored, and the Dashboard control
    // and this one are the same setting rather than two that drift.
    void window.copilot.invoke('overlay:setFontSize', { px });
  }, []);

  const idle = shouldShowIdle(cards, paused);
  const visible = cards.slice(-MAX_CARDS);

  return (
    <div
      data-testid="overlay"
      data-interactive={interactive ? 'true' : 'false'}
      data-overlay-state={idle ? 'idle' : 'active'}
      data-theme={resolved.mode}
      data-translucency={resolved.translucency}
      data-reduced-motion={slide ? 'false' : 'true'}
      className="flex h-screen w-screen flex-col justify-end gap-1 overflow-hidden p-2"
      style={{ ...resolved.vars, fontSize: 'var(--overlay-font-size)' } as CSSProperties}
      // The drag region is live only in interactive mode. In click-through mode
      // the window ignores mouse events anyway, and a permanent drag region
      // would swallow clicks meant for the application behind it (FR-083).
      {...(interactive ? { 'data-drag-region': 'true' } : {})}
    >
      {consent !== null && !dismissed ? (
        <ConsentReminder text={consent} captureNotice={captureNotice} onDismiss={dismiss} />
      ) : null}

      {/*
        The one region allowed to overflow, and it clips from the top.
        `OVERLAY_SIZE` is 420 by 260 and cannot be resized (`FR-081`), so three
        cards of five bullets do not fit at any size the user can choose. What
        must never be pushed off screen is the newest cue and the consent
        reminder; what may be is the oldest card, which is the least useful
        thing on screen. `justify-end` inside `min-h-0 overflow-hidden` puts the
        newest card against the bottom and clips the rest off the top.
      */}
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        {idle ? (
          <IdleCard paused={paused} sessionActive={sessionActive} />
        ) : (
          <div data-testid="card-stack" className="flex flex-col gap-1">
            {/* FR-091: a fourth card entering fades the oldest out. The cap
                lives in `cards.ts`; AnimatePresence is what makes the eviction
                visible rather than instantaneous (ASM-010). */}
            <AnimatePresence initial={false}>
              {visible.map((card, position) => (
                <SuggestionCardView
                  key={card.cardId}
                  card={card}
                  depth={visible.length - 1 - position}
                  slide={slide}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {interactive ? (
        <FontSizeControl fontSizePx={resolved.fontSizePx} onChange={setFontSize} />
      ) : null}
    </div>
  );
}

/**
 * The host's colour-scheme preference, for `theme.mode === 'system'` (FR-029).
 *
 * Subscribed rather than read once: a user who switches Windows to dark mode
 * mid-interview gets the overlay following without a restart, which is the same
 * promise `FR-085` makes for the settings that come over `CH-211`.
 */
function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setPrefersDark(event.matches);
    query.addEventListener('change', onChange);
    setPrefersDark(query.matches);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return prefersDark;
}

const container = document.getElementById('root');
if (container)
  createRoot(container).render(
    <StrictMode>
      <Overlay />
    </StrictMode>,
  );
