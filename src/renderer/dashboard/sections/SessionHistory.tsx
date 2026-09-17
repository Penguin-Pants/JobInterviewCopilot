/**
 * Session History (FR-087, FR-101, FR-110, TC-123).
 *
 * Grouped by profile, because a session belongs to exactly one profile's folder
 * and is bound to it at start (ADR-013). The privacy statement is not a footnote
 * here: `FR-110` requires the Dashboard to say plainly that a transcript is an
 * unencrypted local file kept until the user deletes it.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { Profile, Session, SessionSummary } from '../../../shared/types.js';
import { call } from '../call.js';
import { formatTimestamp, formatUsd } from '../format.js';

export const TRANSCRIPT_PRIVACY_TEXT =
  'Session transcripts are saved on this computer as unencrypted local text files and are kept ' +
  'until you delete them. There is no retention window and no encryption at rest. No audio is ' +
  'ever saved.';

export interface SessionHistoryProps {
  profiles: Profile[];
  /**
   * Re-lists on every `state:session` push, so history is current without a
   * refresh. A counter rather than the session id: crash recovery compacts an
   * orphan transcript after this section has already listed the profile, and it
   * re-pushes a state whose id has not changed. Keyed on the id, that recovered
   * interview stayed invisible until the window was reloaded (FR-105, FR-108).
   */
  sessionRevision: number;
}

export function SessionHistory({ profiles, sessionRevision }: SessionHistoryProps): JSX.Element {
  const [byProfile, setByProfile] = useState<Record<string, SessionSummary[]>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  const profileIds = profiles.map((p) => p.id).join(',');

  /**
   * Two `reload` runs can overlap when the profile list changes while one is in
   * flight. The token makes the newer run win, so a slow earlier answer cannot
   * overwrite it with counts that are already stale.
   */
  const runToken = useRef(0);

  const reload = useCallback(async () => {
    const token = (runToken.current += 1);
    const next: Record<string, SessionSummary[]> = {};
    const errors: Record<string, string> = {};
    for (const id of profileIds.split(',').filter(Boolean)) {
      const result = await call('session:list', { profileId: id });
      if (result.ok) next[id] = result.value;
      else {
        // An empty list is a claim that there is nothing there, and `FR-110`
        // promises transcripts are kept until the user deletes them. Rendering
        // a failed read as "no sessions" contradicts that on screen.
        next[id] = [];
        errors[id] = result.message;
      }
    }
    if (token !== runToken.current) return;
    setByProfile(next);
    setFailed(errors);
    // Keyed on the ids rather than on the array identity. `profile:list`
    // returns a fresh array on every reload, and depending on it would re-list
    // every session on every document-progress tick. The body reads the ids and
    // nothing else, so it cannot go stale against `profiles`.
  }, [profileIds]);

  useEffect(() => {
    void reload();
  }, [reload, sessionRevision]);

  async function remove(sessionId: string): Promise<void> {
    setError(null);
    const result = await call('session:delete', { sessionId });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (opened?.id === sessionId) setOpened(null);
    await reload();
  }

  async function open(sessionId: string): Promise<void> {
    setError(null);
    const result = await call('session:read', { sessionId });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpened(result.value);
  }

  return (
    <section data-testid="section-session-history" aria-labelledby="session-history-heading">
      <h2 id="session-history-heading">Session History</h2>

      <p data-testid="transcript-privacy-note">{TRANSCRIPT_PRIVACY_TEXT}</p>

      {error ? (
        <p role="alert" data-testid="session-history-error">
          {error}
        </p>
      ) : null}

      {profiles.length === 0 ? <p data-testid="no-profiles">There are no profiles yet.</p> : null}

      {profiles.map((profile) => {
        const sessions = byProfile[profile.id] ?? [];
        const failure = failed[profile.id];
        return (
          <div key={profile.id} data-testid={`history-group-${profile.id}`}>
            <h3 data-testid={`history-group-name-${profile.id}`}>{profile.name}</h3>
            {failure ? (
              <p role="alert" data-testid={`history-failed-${profile.id}`}>
                The sessions of this profile could not be read, so this list is not the whole story.{' '}
                {failure}
              </p>
            ) : null}
            {!failure && sessions.length === 0 ? (
              <p data-testid={`history-empty-${profile.id}`}>No sessions in this profile.</p>
            ) : (
              <ul className="rows">
                {sessions.map((summary) => (
                  <li key={summary.id} data-testid={`session-${summary.id}`}>
                    <span data-testid={`session-started-${summary.id}`}>
                      {formatTimestamp(summary.startedAt)}
                    </span>
                    <span>{summary.entryCount} entries</span>
                    <span>{formatUsd(summary.estimatedUsd)}</span>
                    {summary.endReason === 'crash-recovered' ? (
                      <span data-testid={`session-recovered-${summary.id}`}>
                        Recovered after a crash
                      </span>
                    ) : null}
                    <button
                      type="button"
                      data-testid={`session-view-${summary.id}`}
                      onClick={() => void open(summary.id)}
                    >
                      View transcript
                    </button>
                    <button
                      type="button"
                      data-testid={`session-delete-${summary.id}`}
                      onClick={() => void remove(summary.id)}
                    >
                      Delete transcript
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {opened ? (
        <div data-testid="session-viewer" aria-labelledby="session-viewer-heading">
          <h3 id="session-viewer-heading">
            {opened.profileNameSnapshot}, {formatTimestamp(opened.startedAt)}
          </h3>
          <button type="button" data-testid="session-viewer-close" onClick={() => setOpened(null)}>
            Close transcript
          </button>
          <ol data-testid="session-entries">
            {opened.entries.map((entry) => (
              <li key={entry.seq} data-testid={`entry-${entry.seq}`}>
                {entry.kind === 'turn' ? (
                  <span>
                    <strong>{entry.source}</strong>: {entry.text}
                  </span>
                ) : (
                  <span>
                    <strong>suggestion ({entry.status})</strong>: {entry.bullets.join(' | ')}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
