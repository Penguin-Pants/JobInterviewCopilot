import { AnimatePresence } from 'framer-motion';
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
import { ResizeGrip } from './components/ResizeGrip.js';
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
  /**
   * Which session is running, which is what identifies one (FR-006).
   *
   * The boundary is detected from this rather than from watching `active` go
   * false and back to true. See the effect below for why that difference
   * matters.
   */
  const [sessionId, setSessionId] = useState<string | null>(
    () => lastSeen('state:session')?.sessionId ?? null,
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
  /**
   * Bumped at every session boundary, to re-report readiness (FR-006, FR-008).
   *
   * `FR-006` is about every live session, not about the first one, so the
   * answer to "has the reminder been rendered" has to be given again for each.
   * A ref that latched after the first report said yes forever, over a reminder
   * the user had dismissed an interview ago.
   */
  const [readyEpoch, setReadyEpoch] = useState(0);

  /**
   * `prefers-reduced-motion` (NFR-010, FR-092).
   *
   * Read through `matchMedia` and **subscribed**, not through framer-motion's
   * `useReducedMotion`. That hook takes one snapshot and never updates: it
   * carries its own "see if people miss automatically updating" note upstream.
   * A user who turns the preference on mid-interview would keep the slide until
   * the window was rebuilt, while the colour scheme below it followed the host
   * immediately. One of those two matched this file's promise and the other did
   * not, so both are subscribed now.
   *
   * Unknown is treated as "reduce": the slide is enabled only where the host
   * says there is no preference. Guessing the other way runs the exact
   * animation the preference exists to prevent, on the first reveal, which is
   * the one a user who set it is most likely to notice.
   */
  const slide = !useMediaPreference('(prefers-reduced-motion: reduce)', true);

  const prefersDark = useMediaPreference('(prefers-color-scheme: dark)', false);

  /**
   * The size this control has asked for but the store has not confirmed yet
   * (FR-093, CH-126).
   *
   * The main process rate-limits `overlay:setFontSize`, because it is the one
   * write an overlay renderer can reach and each one is a synchronous settings
   * write on the process running the live loop. Coalescing there means the
   * stored value does not move on every press, and without a draft each press
   * would compute its step from a stale rendered number: three quick presses
   * from 26 would all ask for 28. The draft is what makes them accumulate, and
   * it makes the number move on the press rather than a round trip later.
   *
   * It is cleared the moment the store agrees, so the stored value is what
   * survives any disagreement. That is the same shape the Dashboard's own
   * controls use, and for the same reason.
   */
  const [pendingFontSizePx, setPendingFontSizePx] = useState<number | null>(null);
  const storedFontSizePx = theme.overlayFontSizePx;
  useEffect(() => {
    setPendingFontSizePx((draft) => (draft === storedFontSizePx ? null : draft));
  }, [storedFontSizePx]);

  const resolved = useMemo(
    () =>
      resolveOverlayTheme(
        pendingFontSizePx === null ? theme : { ...theme, overlayFontSizePx: pendingFontSizePx },
        { prefersDark, acrylicSupported: platform.acrylicSupported },
      ),
    [theme, pendingFontSizePx, prefersDark, platform.acrylicSupported],
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
        setSessionId(p.sessionId);
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
    if (earlySession) {
      setSessionActive(earlySession.active);
      setSessionId(earlySession.sessionId);
      // `paused` too, as the initialiser above does. `CH-201` carries it, and
      // re-seeding one of its two fields would leave the overlay showing a live
      // card stack over a paused trigger if this push were ever to arrive
      // without a `CH-212` beside it (FR-053).
      setPaused(earlySession.paused);
    }
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
   * **Keyed on the session id, not on watching `active` go false and back.**
   * That heuristic needs the renderer to observe the gap, and it does not
   * always get one: two `CH-201` pushes delivered close enough together land in
   * a single React batch, `active` is then true before and after, React bails
   * out of the render entirely, and the effect never runs. Measured on the
   * built renderer, that is exactly what happens, and the second interview then
   * begins with the reminder still dismissed from the first. A window rebuilt
   * across the boundary loses the gap the same way.
   *
   * The id is what a session *is*, so it cannot be missed: it differs whether
   * or not the renderer ever saw a moment with no session running. A re-push
   * carrying the **same** id is not a boundary, which is what keeps crash
   * recovery, which re-pushes to make Session History look again, from wiping a
   * card mid-interview.
   */
  const lastSessionId = useRef<string | null>(null);
  useEffect(() => {
    if (sessionId !== null && sessionId !== lastSessionId.current) {
      setDismissed(false);
      dispatch({ kind: 'reset' });
      // And readiness is owed again. `OverlayGate.reset()` closes the gate at
      // this same boundary, so until this is answered the next interview's
      // suggestions buffer rather than arriving over a reminder that has not
      // been re-shown yet.
      setReadyEpoch((epoch) => epoch + 1);
    }
    lastSessionId.current = sessionId;
  }, [sessionId]);

  /**
   * Report readiness once the consent card is on screen (FR-008, ADR-016).
   *
   * This used to fire on mount, but the consent text arrives from the main
   * process and the card cannot exist yet at that point. Readiness would then
   * open the suggestion gate before the reminder had rendered, which is the one
   * thing the gate exists to prevent. Waiting for the text and then for a paint
   * makes "the reminder was shown" true when the main process is told so.
   *
   * It runs again at every session boundary, because `FR-006` asks for the
   * reminder before the first suggestion of **every** session and the gate is
   * closed again at the same boundary. Reporting it once, with a latching ref,
   * answered for the first interview and then stood unchallenged over a
   * reminder the user had dismissed.
   *
   * The double `requestAnimationFrame` is the paint, and the cleanup flag is
   * what keeps a superseded epoch, or StrictMode's simulated remount, from
   * reporting on behalf of a card that is no longer the one on screen.
   */
  useEffect(() => {
    if (consent === null) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) void window.copilot.invoke('overlay:ready');
      });
    });
    return () => {
      cancelled = true;
    };
  }, [consent, readyEpoch]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    // The card is gone either way: `FR-006` is about the reminder being
    // dismissible, not about the main process knowing. The call is how the
    // session log can tell an acknowledged reminder from one left on screen.
    void window.copilot.invoke('consent:dismiss');
  }, []);

  /**
   * The resize grip's channel (FR-081, CH-127).
   *
   * Nothing optimistic here, unlike `setFontSize` above. The window's size is
   * the window's, so what the user sees is the resize actually applied rather
   * than a renderer-side guess that the main process may clamp.
   */
  const setWindowSize = useCallback((size: { width: number; height: number }) => {
    void window.copilot.invoke('overlay:setSize', size);
  }, []);

  const setFontSize = useCallback((px: number) => {
    // Shown at once, stored when the main process gets to it. The draft above
    // is cleared as soon as `overlay:theme` comes back carrying this size, so
    // what is on screen a moment later is what was stored, and the Dashboard
    // control and this one remain the same setting rather than two that drift.
    setPendingFontSizePx(px);
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
        The one region allowed to overflow, and it scrolls rather than clips
        (`FR-081`, TASK-052).

        It used to clip from the top, because the window was a fixed 420 by 260
        that the user could not resize, so three cards of five bullets did not
        fit at any font size `FR-093` allowed and something had to go. Text the
        user could neither read nor reach is not a display, and the text-size
        control made it worse rather than better: a larger size hid more. The
        window is resizable now, and what still does not fit scrolls.

        `mt-auto` on the inner stack rather than `justify-end` on the scroller.
        They look the same until the content overflows, and then they differ in
        the way that matters: with `justify-end` the overflow goes off the top
        of the scroll container and cannot be scrolled back to, which is the
        clipping this change exists to end. A top margin of `auto` pins the
        newest card to the bottom while leaving the older ones reachable.
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        {idle ? (
          <IdleCard paused={paused} sessionActive={sessionActive} />
        ) : (
          <div data-testid="card-stack" className="mt-auto flex flex-col gap-1">
            {/*
              FR-091: a fourth card entering fades the oldest out. The cap lives
              in `cards.ts`; AnimatePresence is what makes the eviction visible
              rather than instantaneous (ASM-010).

              No `initial={false}`. It was here to stop a rebuilt overlay
              animating a replayed card in, and it cost `FR-092` instead: this
              AnimatePresence mounts with its first child, because the stack is
              only rendered once a card exists, and on its first render
              `initial={false}` is passed down as `initial: false`. That value
              is memoised on the child's presence context without `initial` as
              a dependency, so it sticks for that card's whole life and reaches
              every `BulletReveal` mounted inside it. Measured on the built
              renderer: the first card of every active period, and all of its
              bullets, appeared at full opacity with no fade and no slide, while
              cards two and three animated correctly. It recurred after every
              pause and every session boundary, because those unmount the stack.
            */}
            <AnimatePresence>
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
        /* The two overlay-side controls share one row. `FontSizeControl` keeps
           its own right alignment, so it takes the free space and the grip sits
           in the corner, which is where a resize affordance is looked for. */
        <div className="flex shrink-0 items-end gap-1">
          <div className="min-w-0 flex-1">
            <FontSizeControl fontSizePx={resolved.fontSizePx} onChange={setFontSize} />
          </div>
          <ResizeGrip onResize={setWindowSize} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One host preference, subscribed (FR-029, NFR-010, FR-085).
 *
 * Subscribed rather than read once: a user who switches Windows to dark mode,
 * or turns on reduced motion, mid-interview gets the overlay following without
 * a restart, which is the same promise `FR-085` makes for the settings that
 * arrive over `CH-211`.
 *
 * `whenUnavailable` is the answer where `matchMedia` is missing, which is a
 * decision per preference rather than a shared default: not knowing the colour
 * scheme means light, and not knowing about reduced motion means reduce.
 */
function useMediaPreference(query: string, whenUnavailable: boolean): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? whenUnavailable,
  );

  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    list.addEventListener('change', onChange);
    setMatches(list.matches);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

const container = document.getElementById('root');
if (container)
  createRoot(container).render(
    <StrictMode>
      <Overlay />
    </StrictMode>,
  );
