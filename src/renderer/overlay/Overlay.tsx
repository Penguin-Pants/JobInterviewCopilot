import { StrictMode, useEffect, useState, type JSX } from 'react';
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

  useEffect(() => {
    const offConsent = window.copilot.on('overlay:consent', (p) => setConsent(p.text));
    const offMode = window.copilot.on('overlay:mode', (p) => setInteractive(p.interactive));
    // Announce readiness only after the first paint, so "the consent reminder
    // was shown" is a fact the main process can assert (ADR-016).
    requestAnimationFrame(() => {
      void window.copilot.invoke('overlay:ready');
    });
    return () => {
      offConsent();
      offMode();
    };
  }, []);

  return (
    <div data-testid="overlay" data-interactive={interactive ? 'true' : 'false'}>
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
