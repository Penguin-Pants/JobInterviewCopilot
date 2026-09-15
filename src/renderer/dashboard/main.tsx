import { StrictMode, useEffect, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { isIpcError } from '../../shared/ipc.js';
import type { Settings } from '../../shared/types.js';

/**
 * Dashboard shell (CMP-13).
 *
 * Milestone 0 renders the frame, the capture-fidelity notice (NFR-012) and the
 * Reset Overlay action (FR-009). The six configuration sections are TASK-042.
 */

function Dashboard(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetState, setResetState] = useState<'idle' | 'done' | 'failed'>('idle');

  useEffect(() => {
    void window.copilot.invoke('config:get').then(setSettings);
    return window.copilot.on('notice:captureFidelity', (p) => setNotice(p.message));
  }, []);

  return (
    <main data-testid="dashboard">
      <h1>Interview CoPilot</h1>

      {notice ? (
        <p role="status" data-testid="capture-fidelity-notice">
          {notice}
        </p>
      ) : null}

      <section>
        <h2>Overlay</h2>
        <button
          type="button"
          data-testid="reset-overlay"
          onClick={() => {
            // An IPC rejection resolves like any other response, so it has to be
            // checked. Reporting it as success is how a failed reset looked fine.
            void window.copilot
              .invoke('overlay:reset')
              .then((result) => setResetState(isIpcError(result) ? 'failed' : 'done'))
              .catch(() => setResetState('failed'));
          }}
        >
          Reset Overlay
        </button>
        {resetState === 'done' ? <span data-testid="reset-overlay-done">Overlay reset</span> : null}
        {resetState === 'failed' ? (
          <span role="alert" data-testid="reset-overlay-failed">
            Could not reset the overlay. See the log for details.
          </span>
        ) : null}
      </section>

      <section>
        <h2>Status</h2>
        <p data-testid="active-stt">
          {settings
            ? `${settings.providers.stt.primary.providerId} / ${settings.providers.stt.primary.modelId}`
            : 'loading'}
        </p>
      </section>

      <p data-testid="transcript-privacy-note">
        Session transcripts are saved on this computer as unencrypted local files and are kept until
        you delete them. No audio is ever saved.
      </p>
    </main>
  );
}

const container = document.getElementById('root');
if (container)
  createRoot(container).render(
    <StrictMode>
      <Dashboard />
    </StrictMode>,
  );
