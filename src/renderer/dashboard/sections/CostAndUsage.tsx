/**
 * Cost and Usage (FR-031, FR-072, FR-087, FR-103, FR-109, ASM-011).
 *
 * The timer and the estimate are rendered from `CH-204`, which the Cost Meter
 * pushes once a second for the whole of a session. Nothing is computed here: an
 * estimate the Dashboard worked out for itself would be a second answer to a
 * question the meter already answers, and the two would disagree the moment a
 * failover moved a stream to a model at a different price (ADR-033).
 */
import { useEffect, useState, type JSX } from 'react';
import type { Settings } from '../../../shared/types.js';
import { call } from '../call.js';
import { formatElapsed, formatUsd } from '../format.js';
import type { SessionState, UsageState, UsageWarning } from '../state.js';

export interface CostAndUsageProps {
  settings: Settings;
  session: SessionState;
  usage: UsageState | null;
  warnings: UsageWarning[];
  onSettingsChanged: () => Promise<void>;
}

export function CostAndUsage({
  settings,
  session,
  usage,
  warnings,
  onSettingsChanged,
}: CostAndUsageProps): JSX.Element {
  const [costUsd, setCostUsd] = useState(String(settings.thresholds.costUsd));
  const [timeMinutes, setTimeMinutes] = useState(String(settings.thresholds.timeMinutes));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setCostUsd(String(settings.thresholds.costUsd));
    setTimeMinutes(String(settings.thresholds.timeMinutes));
  }, [settings.thresholds.costUsd, settings.thresholds.timeMinutes]);

  async function saveThresholds(): Promise<void> {
    setError(null);
    setSaved(false);
    const cost = Number(costUsd);
    const minutes = Number(timeMinutes);
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(minutes) || minutes <= 0) {
      setError('Give a cost of zero or more and a time of more than zero minutes.');
      return;
    }
    const result = await call('config:set', {
      thresholds: { costUsd: cost, timeMinutes: minutes },
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSaved(true);
    await onSettingsChanged();
  }

  const audioSeconds = usage
    ? usage.sttAudioSeconds.interviewer + usage.sttAudioSeconds.candidate
    : 0;

  return (
    <section data-testid="section-cost-and-usage" aria-labelledby="cost-heading">
      <h2 id="cost-heading">Cost and Usage</h2>

      <dl data-testid="live-usage" data-session-active={session.active ? 'true' : 'false'}>
        <dt>Session time</dt>
        <dd data-testid="live-timer">{formatElapsed(usage?.elapsedSeconds ?? 0)}</dd>

        <dt>Estimated spend</dt>
        <dd data-testid="live-spend">{formatUsd(usage?.estimatedUsd ?? 0)}</dd>

        <dt>Audio transcribed</dt>
        <dd data-testid="live-audio-seconds">{Math.round(audioSeconds)} seconds</dd>

        <dt>Tokens</dt>
        <dd data-testid="live-tokens">
          {usage?.llmInputTokens ?? 0} in, {usage?.llmOutputTokens ?? 0} out
        </dd>

        <dt>Price table</dt>
        <dd data-testid="price-table-version">{usage?.priceTableVersion || 'not loaded yet'}</dd>
      </dl>

      {usage?.estimateIncomplete ? (
        <p role="status" data-testid="estimate-incomplete">
          This estimate is incomplete. A model used in this session has no price on record, so the
          real spend is higher than the number above.
        </p>
      ) : null}

      {!session.active ? (
        <p data-testid="no-live-session">
          No session is running. The timer and the estimate move once a session starts.
        </p>
      ) : null}

      {warnings.map((warning) => (
        <p role="alert" key={warning.kind} data-testid={`usage-warning-${warning.kind}`}>
          {warning.kind === 'cost'
            ? `Estimated spend has passed ${formatUsd(warning.threshold)} and is now ${formatUsd(warning.value)}.`
            : `This session has passed ${warning.threshold} minutes and is now ${Math.round(warning.value)} minutes long.`}{' '}
          The session is still running. This is a notice, not a stop.
        </p>
      ))}

      <h3>Thresholds</h3>
      <p>Each threshold warns once per session. Neither one stops a session.</p>
      <label htmlFor="threshold-cost">Cost threshold in US dollars</label>
      <input
        id="threshold-cost"
        data-testid="threshold-cost"
        type="number"
        min="0"
        step="0.5"
        value={costUsd}
        onChange={(e) => setCostUsd(e.target.value)}
      />
      <label htmlFor="threshold-time">Time threshold in minutes</label>
      <input
        id="threshold-time"
        data-testid="threshold-time"
        type="number"
        min="1"
        step="5"
        value={timeMinutes}
        onChange={(e) => setTimeMinutes(e.target.value)}
      />
      <button type="button" data-testid="save-thresholds" onClick={() => void saveThresholds()}>
        Save thresholds
      </button>
      {saved ? <span data-testid="thresholds-saved">Saved</span> : null}
      {error ? (
        <span role="alert" data-testid="thresholds-error">
          {error}
        </span>
      ) : null}
    </section>
  );
}
