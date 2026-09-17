/**
 * Company Profiles and the document manager (FR-027, FR-028, FR-063, FR-064,
 * FR-068, FR-069, FR-079, FR-087, ADR-011, ADR-013, ADR-026).
 *
 * Exactly one profile is active. The active profile is bound at session start
 * and cannot change while a session runs, so the switch control is disabled for
 * the whole of one (ADR-013).
 */
import { useCallback, useEffect, useState, type DragEvent, type JSX } from 'react';
import { KB_CEILING } from '../../../shared/defaults.js';
import type { DocType, DocumentRecord, Profile } from '../../../shared/types.js';
import { call } from '../call.js';
import { formatBytes } from '../format.js';
import type { DocProgress, ModelState, SessionState } from '../state.js';

const DOC_TYPES: { value: DocType | 'auto'; label: string }[] = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'resume', label: 'Resume' },
  { value: 'company-notes', label: 'Company notes' },
  { value: 'job-description', label: 'Job description' },
];

const BEST_EFFORT_EXPLANATION =
  'The text was recovered from a scanned or image-only file, so headings and ' +
  'reading order may be wrong and some words may be missing. Replace it with a ' +
  'text-based file for better answers.';

interface PendingDelete {
  profile: Profile;
  documents: number;
  /** null when `session:list` failed. Never rendered as zero (FR-028). */
  sessions: number | null;
}

export interface CompanyProfilesProps {
  profiles: Profile[];
  activeProfileId: string;
  session: SessionState;
  model: ModelState | null;
  docProgress: Record<string, DocProgress>;
  onProfilesChanged: () => Promise<void>;
  onSettingsChanged: () => Promise<void>;
}

export function CompanyProfiles({
  profiles,
  activeProfileId,
  session,
  model,
  docProgress,
  onProfilesChanged,
  onSettingsChanged,
}: CompanyProfilesProps): JSX.Element {
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);

  const active = profiles.find((p) => p.id === activeProfileId) ?? null;

  const refresh = useCallback(async () => {
    await onProfilesChanged();
    await onSettingsChanged();
  }, [onProfilesChanged, onSettingsChanged]);

  // A profile deleted elsewhere must not leave a confirmation dialog standing
  // over a profile that no longer exists, and a session starting must not leave
  // one standing over an action that is no longer allowed.
  useEffect(() => {
    if (pendingDelete && !profiles.some((p) => p.id === pendingDelete.profile.id)) {
      setPendingDelete(null);
    }
  }, [profiles, pendingDelete]);

  useEffect(() => {
    if (session.active) setPendingDelete(null);
  }, [session.active]);

  /**
   * One create at a time.
   *
   * The name is cleared only once `profile:create` has answered, so two clicks
   * inside that round trip both read the same `newName` and both create a
   * profile. `FR-027` is about which profile is active rather than about
   * duplicate names, so nothing downstream refuses the second one: the user
   * gets two profiles, each with its own knowledge base, from one action.
   */
  const [creating, setCreating] = useState(false);

  async function create(): Promise<void> {
    setError(null);
    const name = newName.trim();
    if (name.length === 0) {
      setError('Give the profile a name first.');
      return;
    }
    setCreating(true);
    try {
      const result = await call('profile:create', { name });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNewName('');
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  async function activate(id: string): Promise<void> {
    setError(null);
    const result = await call('profile:activate', { id });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await refresh();
  }

  /**
   * The confirmation has to name what is about to go (FR-028, TC-122).
   *
   * The session count is read here rather than carried on the profile, because
   * `kb/` and the sessions folder are authoritative and a cached count would be
   * the number that is wrong exactly when it matters.
   */
  async function askToDelete(profile: Profile): Promise<void> {
    setError(null);
    const sessions = await call('session:list', { profileId: profile.id });
    setPendingDelete({
      profile,
      documents: profile.documents.length,
      // A failed list is not "no sessions". Reported as zero, the confirmation
      // told the user nothing would be lost and then deleted every transcript
      // in the profile.
      sessions: sessions.ok ? sessions.value.length : null,
    });
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    const result = await call('profile:delete', { id: pendingDelete.profile.id });
    setPendingDelete(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await refresh();
  }

  async function importPaths(paths: string[]): Promise<void> {
    if (!active) {
      // A drop with no active profile has nowhere to go. Saying nothing looked
      // exactly like an import that had silently failed.
      setError('Activate a profile before adding documents to it.');
      return;
    }
    setError(null);
    if (paths.length === 0) {
      setImportNote('None of the dropped items is a file on disk.');
      return;
    }
    const result = await call('doc:import', { profileId: active.id, paths });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setImportNote(`Importing ${result.value.length} document(s).`);
    await refresh();
  }

  async function pickFiles(): Promise<void> {
    if (!active) return;
    setError(null);
    const result = await call('doc:pickFiles', { profileId: active.id });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // A cancelled dialog answers `[]`. Saying nothing is the right response to
    // a user who changed their mind; an error would be a lie.
    if (result.value.length > 0) {
      setImportNote(`Importing ${result.value.length} document(s).`);
      await refresh();
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDropTarget(false);
    if (!window.copilot.pathForFile) {
      setError('This window cannot resolve dropped files. Use Add documents instead.');
      return;
    }
    // Called on the bridge rather than through a detached reference: the object
    // crosses `contextBridge`, and a detached member of a bridged object is not
    // guaranteed to stay callable.
    const paths = [...event.dataTransfer.files]
      .map((file) => window.copilot.pathForFile?.(file) ?? '')
      .filter((path) => path.length > 0);
    void importPaths(paths);
  }

  return (
    <section data-testid="section-company-profiles" aria-labelledby="company-profiles-heading">
      <h2 id="company-profiles-heading">Company Profiles</h2>

      <p data-testid="active-profile-statement">
        {active
          ? `${active.name} is the active profile. Exactly one profile is active at a time.`
          : 'No profile is active yet. Create one to start.'}
      </p>

      {session.active ? (
        <p role="status" data-testid="profile-switch-locked">
          A session is running in {session.profileName ?? 'this profile'}. The active profile is
          bound for the whole session, so switching and deleting are disabled until it stops.
        </p>
      ) : null}

      <div>
        <label htmlFor="new-profile-name">New profile name</label>
        <input
          id="new-profile-name"
          data-testid="new-profile-name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="button"
          data-testid="create-profile"
          disabled={creating}
          onClick={() => void create()}
        >
          Create profile
        </button>
      </div>

      {error ? (
        <p role="alert" data-testid="profile-error">
          {error}
        </p>
      ) : null}

      <ul className="rows" data-testid="profile-list">
        {profiles.map((profile) => (
          <li key={profile.id} data-testid={`profile-${profile.id}`} data-profile-id={profile.id}>
            <span data-testid={`profile-name-${profile.id}`}>{profile.name}</span>
            {profile.id === activeProfileId ? (
              <span data-testid={`profile-active-${profile.id}`}>Active</span>
            ) : null}
            <button
              type="button"
              data-testid={`profile-activate-${profile.id}`}
              disabled={session.active || profile.id === activeProfileId}
              onClick={() => void activate(profile.id)}
            >
              Switch to this profile
            </button>
            <button
              type="button"
              data-testid={`profile-delete-${profile.id}`}
              disabled={session.active}
              onClick={() => void askToDelete(profile)}
            >
              Delete profile
            </button>
          </li>
        ))}
      </ul>

      {pendingDelete ? (
        <div
          role="alertdialog"
          aria-labelledby="delete-confirm-heading"
          data-testid="delete-confirm"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPendingDelete(null);
          }}
        >
          <h3 id="delete-confirm-heading">Delete {pendingDelete.profile.name}?</h3>
          <p data-testid="delete-confirm-counts">
            This deletes {pendingDelete.documents} document
            {pendingDelete.documents === 1 ? '' : 's'} and{' '}
            {pendingDelete.sessions === null
              ? 'an unknown number of sessions, because the session list could not be read'
              : `${pendingDelete.sessions} session${pendingDelete.sessions === 1 ? '' : 's'}`}
            , including their transcripts. It cannot be undone.
          </p>
          <button
            type="button"
            data-testid="delete-confirm-yes"
            // The row's own delete button is disabled during a session and the
            // section says deleting is disabled until it stops. This dialog is
            // not modal, so a session can start while it is open, and without
            // the same guard the dialog contradicted that sentence.
            disabled={session.active}
            onClick={() => void confirmDelete()}
          >
            Delete it
          </button>
          <button
            type="button"
            data-testid="delete-confirm-no"
            // Focused on open, so the keyboard lands on the safe choice and the
            // dialog's `alertdialog` role is not a claim nothing acts on.
            autoFocus
            onClick={() => setPendingDelete(null)}
          >
            Keep it
          </button>
        </div>
      ) : null}

      <h3>Knowledge base</h3>
      <p data-testid="kb-ceiling">
        A document of {formatBytes(KB_CEILING.maxBytes)} or less and {KB_CEILING.maxChunks} chunks
        or fewer is searchable within {KB_CEILING.reembedTargetMs / 1000} seconds of a change.
        Larger documents are still imported and still show progress, but that target does not apply.
      </p>

      <ModelGate model={model} />

      <div
        data-testid="drop-zone"
        data-drop-active={dropTarget ? 'true' : 'false'}
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget(true);
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={onDrop}
      >
        <p>Drag Markdown, PDF or Word files here to add them to this profile.</p>
        <button
          type="button"
          data-testid="pick-files"
          disabled={!active}
          onClick={() => void pickFiles()}
        >
          Add documents
        </button>
      </div>
      {importNote ? (
        <p role="status" data-testid="import-note">
          {importNote}
        </p>
      ) : null}

      <ul className="rows" data-testid="document-list">
        {(active?.documents ?? []).map((doc) => (
          <DocumentRow
            key={doc.id}
            doc={doc}
            progress={docProgress[doc.id] ?? null}
            onChanged={refresh}
          />
        ))}
      </ul>
      {active && active.documents.length === 0 ? (
        <p data-testid="no-documents">No documents in this profile yet.</p>
      ) : null}
    </section>
  );
}

/** The embedding model gate and its retry (ADR-011, ADR-026, TC-161). */
function ModelGate({ model }: { model: ModelState | null }): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!model) return null;
  if (model.kind === 'ready') {
    // Rendered rather than omitted, so "the model is ready" and "the main
    // process has not said yet" are two different things on screen and in a
    // test, instead of both being an absence.
    return <p data-testid="model-ready">The local embedding model is downloaded and ready.</p>;
  }

  return (
    <div role="status" data-testid="model-gate" data-model-state={model.kind}>
      {model.kind === 'not-downloaded' ? (
        <p>
          The local embedding model has not been downloaded yet. Documents are kept and are embedded
          once it is here.
        </p>
      ) : null}
      {model.kind === 'downloading' ? (
        <p>Downloading the local embedding model: {Math.round(model.percent)} percent.</p>
      ) : null}
      {model.kind === 'unavailable' ? <p>{model.reason}</p> : null}
      {error ? (
        <p role="alert" data-testid="model-gate-error">
          {error}
        </p>
      ) : null}
      {model.kind === 'downloading' ? null : (
        <button
          type="button"
          data-testid="model-retry"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            // The outcome arrives on `CH-214` when the call gets that far. An
            // `IpcError` never reaches that channel, so ignoring this result
            // re-enabled the button and said nothing at all.
            void call('model:ensure')
              .then((result) => {
                if (!result.ok) setError(result.message);
              })
              .finally(() => setBusy(false));
          }}
        >
          Download the model now
        </button>
      )}
    </div>
  );
}

function DocumentRow({
  doc,
  progress,
  onChanged,
}: {
  doc: DocumentRecord;
  progress: DocProgress | null;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const state = progress?.state ?? doc.state;

  /**
   * Every document action answers the same way: reload on success, show the
   * reason on failure. Written once, because three copies of the same
   * `.then` block is three places for the error branch to be dropped from.
   */
  const run = <C extends 'doc:setType' | 'doc:retry' | 'doc:delete'>(
    channel: C,
    payload: Parameters<typeof call<C>>[1],
  ): void => {
    setError(null);
    void call(channel, payload).then(async (result) => {
      if (!result.ok) setError(result.message);
      else await onChanged();
    });
  };

  return (
    <li data-testid={`document-${doc.id}`} data-doc-state={state}>
      <span data-testid={`document-name-${doc.id}`}>{doc.originalFileName}</span>
      <span data-testid={`document-state-${doc.id}`}>
        {state}
        {progress && state !== 'ready' && state !== 'error'
          ? ` ${Math.round(progress.percent)} percent`
          : ''}
      </span>
      <span data-testid={`document-chunks-${doc.id}`}>{doc.chunkCount} chunks</span>

      {doc.extractionQuality === 'best-effort' ? (
        <span data-testid={`document-best-effort-${doc.id}`} title={BEST_EFFORT_EXPLANATION}>
          Best effort text
        </span>
      ) : null}

      <label htmlFor={`doc-type-${doc.id}`}>Document type</label>
      <select
        id={`doc-type-${doc.id}`}
        data-testid={`document-type-${doc.id}`}
        value={doc.docTypeSource === 'user' ? doc.docType : 'auto'}
        onChange={(e) =>
          run('doc:setType', {
            docId: doc.id,
            profileId: doc.profileId,
            docType: e.target.value as DocType | 'auto',
          })
        }
      >
        {DOC_TYPES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
            {option.value === 'auto' && doc.docTypeSource === 'auto' ? ` (${doc.docType})` : ''}
          </option>
        ))}
      </select>

      {state === 'error' ? (
        <>
          <span role="alert" data-testid={`document-error-${doc.id}`}>
            {doc.errorMessage ?? 'This document could not be processed.'}
          </span>
          <button
            type="button"
            data-testid={`document-retry-${doc.id}`}
            onClick={() => run('doc:retry', { docId: doc.id, profileId: doc.profileId })}
          >
            Try again
          </button>
        </>
      ) : null}

      <button
        type="button"
        data-testid={`document-delete-${doc.id}`}
        onClick={() => run('doc:delete', { docId: doc.id, profileId: doc.profileId })}
      >
        Remove document
      </button>

      {error ? (
        <span role="alert" data-testid={`document-action-error-${doc.id}`}>
          {error}
        </span>
      ) : null}
    </li>
  );
}
