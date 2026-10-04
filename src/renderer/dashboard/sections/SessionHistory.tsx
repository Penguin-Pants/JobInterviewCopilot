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
import { focusLater } from '../focus.js';
import { formatTimestamp, formatUsd } from '../format.js';
import { useInFlight } from '../inFlight.js';

const HEADING_ID = 'session-history-heading';
const VIEWER_HEADING_ID = 'session-viewer-heading';

function viewButtonId(sessionId: string): string {
  return `session-view-button-${sessionId}`;
}

function deleteButtonId(sessionId: string): string {
  return `session-delete-button-${sessionId}`;
}

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
  /**
   * Whether `session:list` has answered for the profiles on screen yet.
   *
   * Without it, a group with no entry in `byProfile` read as an empty one, and
   * "No sessions in this profile." appeared over transcripts that were still on
   * disk and simply had not been read. That is the same sentence, and the same
   * contradiction of `FR-110`, that a **failed** read used to produce; the
   * fix for that one distinguished failure from emptiness and left this third
   * case, not yet read, still folded into emptiness. `reload` walks the
   * profiles one at a time, so the last group carries the wrong sentence for as
   * long as every earlier round trip takes.
   */
  const [loaded, setLoaded] = useState(false);
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
    setLoaded(true);
    // Keyed on the ids rather than on the array identity. `profile:list`
    // returns a fresh array on every reload, and depending on it would re-list
    // every session on every document-progress tick. The body reads the ids and
    // nothing else, so it cannot go stale against `profiles`.
  }, [profileIds]);

  useEffect(() => {
    // A new profile list is a new question, so the old answer stops standing
    // for it. Left true, a profile added mid-session would show the empty
    // sentence before its own list had been asked for.
    setLoaded(false);
    void reload();
  }, [reload, sessionRevision]);

  /**
   * The transcript a Delete transcript press is asking about (FR-110).
   *
   * Deleting a transcript cannot be undone, and it was one click on a button
   * that sits beside View transcript in every row. It now asks first, with the
   * same non-modal `alertdialog` a profile delete uses.
   */
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const deleting = useInFlight();

  function cancelDelete(): void {
    if (pendingDelete) focusLater(deleteButtonId(pendingDelete.id));
    setPendingDelete(null);
  }

  async function remove(sessionId: string): Promise<void> {
    setError(null);
    const result = await call('session:delete', { sessionId });
    if (!result.ok) {
      setError(result.message);
      focusLater(deleteButtonId(sessionId));
      setPendingDelete(null);
      return;
    }
    if (opened?.id === sessionId) setOpened(null);
    setPendingDelete(null);
    // The row is gone, so focus goes to the section heading.
    focusLater(HEADING_ID);
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
    // The transcript renders below every group, often off screen. Its heading
    // takes focus so a keyboard or screen reader user lands on it (NFR-010).
    focusLater(VIEWER_HEADING_ID);
  }

  function close(): void {
    if (opened) focusLater(viewButtonId(opened.id));
    setOpened(null);
  }

  return (
    <section data-testid="section-session-history" aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID} tabIndex={-1}>
        Session History
      </h2>

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
            {!failure && !loaded && sessions.length === 0 ? (
              <p role="status" data-testid={`history-loading-${profile.id}`}>
                Reading this profile&rsquo;s sessions&hellip;
              </p>
            ) : null}
            {!failure && loaded && sessions.length === 0 ? (
              <p data-testid={`history-empty-${profile.id}`}>No sessions in this profile.</p>
            ) : null}
            {sessions.length > 0 ? (
              <ul className="rows">
                {sessions.map((summary) => {
                  // Every row has the same two buttons, so each name carries
                  // its session. A list of identical "Delete transcript"
                  // buttons gave a screen reader no way to tell them apart.
                  const started = formatTimestamp(summary.startedAt);
                  return (
                    <li key={summary.id} data-testid={`session-${summary.id}`}>
                      <span data-testid={`session-started-${summary.id}`}>{started}</span>
                      <span>{summary.entryCount} entries</span>
                      <span>{formatUsd(summary.estimatedUsd)}</span>
                      {summary.endReason === 'crash-recovered' ? (
                        <span data-testid={`session-recovered-${summary.id}`}>
                          Recovered after a crash
                        </span>
                      ) : null}
                      <button
                        type="button"
                        id={viewButtonId(summary.id)}
                        data-testid={`session-view-${summary.id}`}
                        aria-label={`View transcript of the session started ${started}`}
                        onClick={() => void open(summary.id)}
                      >
                        View transcript
                      </button>
                      <button
                        type="button"
                        id={deleteButtonId(summary.id)}
                        data-testid={`session-delete-${summary.id}`}
                        aria-label={`Delete transcript of the session started ${started}`}
                        onClick={() => setPendingDelete(summary)}
                      >
                        Delete transcript
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}

      {pendingDelete ? (
        <div
          role="alertdialog"
          aria-labelledby="session-delete-confirm-heading"
          aria-describedby="session-delete-confirm-text"
          data-testid="session-delete-confirm"
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancelDelete();
          }}
        >
          <h3 id="session-delete-confirm-heading">
            Delete the transcript of the session started {formatTimestamp(pendingDelete.startedAt)}?
          </h3>
          <p id="session-delete-confirm-text">
            This deletes its {pendingDelete.entryCount} entries from this computer. It cannot be
            undone.
          </p>
          <button
            type="button"
            data-testid="session-delete-confirm-yes"
            aria-disabled={deleting.busy || undefined}
            onClick={() => void deleting.run(() => remove(pendingDelete.id))}
          >
            Delete it
          </button>
          <button
            type="button"
            data-testid="session-delete-confirm-no"
            // Focused on open, so the keyboard lands on the safe choice.
            autoFocus
            onClick={cancelDelete}
          >
            Keep it
          </button>
        </div>
      ) : null}

      {opened ? (
        <div data-testid="session-viewer" role="region" aria-labelledby={VIEWER_HEADING_ID}>
          <h3 id={VIEWER_HEADING_ID} tabIndex={-1}>
            {opened.profileNameSnapshot}, {formatTimestamp(opened.startedAt)}
          </h3>
          <button type="button" data-testid="session-viewer-close" onClick={close}>
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
