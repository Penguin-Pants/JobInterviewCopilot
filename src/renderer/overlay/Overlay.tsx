import { StrictMode, useEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Teleprompter overlay (CMP-14).
 *
 * Milestone 0 renders the idle card and the consent reminder, and reports
 * readiness so the main process can stop buffering suggestions (FR-008,
 * ADR-016). The card stack and animation are TASK-043.
 *
 * There is no error state in this component tree, by design (FR-076).
 */

function Overlay(): JSX.Element {
  const [consent, setConsent] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const reported = useRef(false);

  useEffect(() => {
    const offConsent = window.copilot.on('overlay:consent', (p) => setConsent(p.text));
    const offMode = window.copilot.on('overlay:mode', (p) => setInteractive(p.interactive));
    return () => {
      offConsent();
      offMode();
    };
  }, []);

  /**
   * Report readiness only once the consent card is on screen (ADR-016).
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

  return (
    <div
      data-testid="overlay"
      data-interactive={interactive ? 'true' : 'false'}
      // The drag region is live only in interactive mode. In click-through mode
      // the window ignores mouse events anyway, and a permanent drag region
      // would swallow clicks meant for the application behind it (FR-083).
      {...(interactive ? { 'data-drag-region': 'true' } : {})}
    >
      {consent && !dismissed ? (
        <section data-testid="consent-reminder">
          <p>{consent}</p>
          <button type="button" data-testid="consent-dismiss" onClick={() => setDismissed(true)}>
            Got it
          </button>
        </section>
      ) : null}

      <section data-testid="idle-card">
        <p>Standing by</p>
      </section>
    </div>
  );
}

const container = document.getElementById('root');
if (container)
  createRoot(container).render(
    <StrictMode>
      <Overlay />
    </StrictMode>,
  );
