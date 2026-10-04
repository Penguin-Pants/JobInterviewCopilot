/**
 * Company Profiles and the document manager (FR-027, FR-028, FR-063, FR-064,
 * FR-068, FR-069, FR-079, FR-087, ADR-011, ADR-013, ADR-026).
 *
 * Exactly one profile is active. The active profile is bound at session start
 * and cannot change while a session runs, so the switch control is disabled for
 * the whole of one (ADR-013).
 *
 * "Disabled" here is `aria-disabled`, never native `disabled` (`inFlight.ts`,
 * NFR-010). A session can start from a hotkey while focus is on a row's
 * button, and Switch to this profile becomes unavailable through its own
 * press. Chromium drops focus from a focused control that becomes `disabled`,
 * so each handler refuses what the attribute announces instead.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type JSX,
} from 'react';
import { KB_CEILING } from '../../../shared/defaults.js';
import { DEFAULT_PROMPT_ID, DEFAULT_PROMPT_NAME, promptName } from '../../../shared/prompts.js';
import type { DocType, DocumentRecord, Profile, Settings } from '../../../shared/types.js';
import { call } from '../call.js';
import { focusLater, focusWithin } from '../focus.js';
import { formatBytes } from '../format.js';
import { useInFlight } from '../inFlight.js';
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

/**
 * The download percent a screen reader is told (NFR-010).
 *
 * The model pushes progress many times a second, and a `role="status"` region
 * whose text changes on each push is read out on each push. Quarters are
 * enough to follow; the exact number stays on screen.
 */
export function announcedPercent(percent: number): number {
  return Math.floor(percent / 25) * 25;
}

export interface PromptSelection {
  /** The stored selections, from each settings reload. */
  sync: (stored: Record<string, string>) => void;
  /** Writes one profile's choice merged with every choice made before it. */
  select: (profileId: string, promptId: string) => Promise<boolean>;
}

/**
 * Each profile's suggestion prompt, merged against the newest choices (FR-027).
 *
 * `config:set` replaces the whole `profilePromptIds` map, and each change built
 * it from the `settings` prop. Two quick changes both read the same prop, so
 * the second write dropped the first change. Here each change merges with the
 * choices made before it, and a reload that answers while a write is pending
 * does not replace them: it can predate that write. A refused write is
 * dropped, so the next one does not send it again.
 */
export function createPromptSelection(
  write: (ids: Record<string, string>) => Promise<boolean>,
): PromptSelection {
  let stored: Record<string, string> = {};
  let latest: Record<string, string> = {};
  let pending = 0;
  return {
    sync(next) {
      stored = next;
      if (pending === 0) latest = next;
    },
    async select(profileId, promptId) {
      const ids = { ...latest };
      if (promptId === DEFAULT_PROMPT_ID) delete ids[profileId];
      else ids[profileId] = promptId;
      latest = ids;
      pending += 1;
      let ok = false;
      try {
        ok = await write(ids);
        return ok;
      } finally {
        pending -= 1;
        if (!ok && pending === 0) latest = stored;
      }
    },
  };
}

export interface CompanyProfilesProps {
  profiles: Profile[];
  activeProfileId: string;
  session: SessionState;
  model: ModelState | null;
  docProgress: Record<string, DocProgress>;
  onProfilesChanged: () => Promise<void>;
  onSettingsChanged: () => Promise<void>;
  settings: Settings;
}

export function CompanyProfiles({
  profiles,
  activeProfileId,
  session,
  model,
  docProgress,
  onProfilesChanged,
  onSettingsChanged,
  settings,
}: CompanyProfilesProps): JSX.Element {
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);

  const active = profiles.find((p) => p.id === activeProfileId) ?? null;

  const refresh = useCallback(async () => {
    await onProfilesChanged();
    await onSettingsChanged();
  }, [onProfilesChanged, onSettingsChanged]);

  /**
   * Closes the delete dialog and puts focus somewhere that still exists
   * (NFR-010). The dialog's buttons go with it, so without this focus fell to
   * the page body. Moved only when focus was in the dialog: a dialog closed by
   * a session starting must not pull focus from wherever the user is.
   */
  function closeDelete(focusId: string): void {
    const hadFocus = focusWithin(document.activeElement, [dialog.current]);
    setPendingDelete(null);
    if (hadFocus) focusLater(focusId);
  }

  // A profile deleted elsewhere must not leave a confirmation dialog standing
  // over a profile that no longer exists, and a session starting must not leave
  // one standing over an action that is no longer allowed.
  useEffect(() => {
    if (pendingDelete && !profiles.some((p) => p.id === pendingDelete.profile.id)) {
      closeDelete(HEADING_ID);
    }
  }, [profiles, pendingDelete]);

  useEffect(() => {
    if (session.active && pendingDelete) closeDelete(deleteButtonId(pendingDelete.profile.id));
  }, [session.active]);

  /**
   * One create at a time.
   *
   * The name is cleared only once `profile:create` has answered, so two clicks
   * inside that round trip both read the same `newName` and both create a
   * profile. `FR-027` is about which profile is active rather than about
   * duplicate names, so nothing downstream refuses the second one: the user
   * gets two profiles, each with its own knowledge base, from one action.
   *
   * The gate is on the form's submit, so it also refuses a second Enter in the
   * name field, which the native `disabled` on the button used to stop.
   */
  const creating = useInFlight();

  async function create(): Promise<void> {
    setError(null);
    const name = newName.trim();
    if (name.length === 0) {
      setError('Give the profile a name first.');
      return;
    }
    const result = await call('profile:create', { name });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNewName('');
    await refresh();
  }

  async function activate(id: string): Promise<void> {
    if (session.active || id === activeProfileId) return;
    setError(null);
    const result = await call('profile:activate', { id });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await refresh();
  }

  // Built once: it holds the choices made since the last reload.
  const [promptSelection] = useState(() =>
    createPromptSelection(async (profilePromptIds) => {
      const result = await call('config:set', { profilePromptIds });
      if (!result.ok) setError(result.message);
      return result.ok;
    }),
  );
  const storedPromptIds = JSON.stringify(settings.profilePromptIds);
  useEffect(() => {
    promptSelection.sync(JSON.parse(storedPromptIds) as Record<string, string>);
  }, [storedPromptIds, promptSelection]);

  async function selectPrompt(profileId: string, promptId: string): Promise<void> {
    setError(null);
    if (await promptSelection.select(profileId, promptId)) await onSettingsChanged();
  }

  /**
   * The confirmation has to name what is about to go (FR-028, TC-122).
   *
   * The session count is read here rather than carried on the profile, because
   * `kb/` and the sessions folder are authoritative and a cached count would be
   * the number that is wrong exactly when it matters.
   */
  async function askToDelete(profile: Profile): Promise<void> {
    if (session.active) return;
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
    if (!pendingDelete || session.active) return;
    const id = pendingDelete.profile.id;
    const result = await call('profile:delete', { id });
    if (!result.ok) {
      closeDelete(deleteButtonId(id));
      setError(result.message);
      return;
    }
    // The row is gone, so focus goes to the section heading above the list.
    closeDelete(HEADING_ID);
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
    <section data-testid="section-company-profiles" aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID} tabIndex={-1}>
        Company Profiles
      </h2>

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

      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void creating.run(create);
        }}
      >
        <label htmlFor="new-profile-name">New profile name</label>
        <input
          id="new-profile-name"
          data-testid="new-profile-name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="submit"
          data-testid="create-profile"
          aria-disabled={creating.busy || undefined}
        >
          Create profile
        </button>
      </form>

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
            <>
              <label htmlFor={`profile-prompt-${profile.id}`}>Suggestion prompt</label>
              <select
                id={`profile-prompt-${profile.id}`}
                data-testid={`profile-prompt-${profile.id}`}
                value={settings.profilePromptIds[profile.id] ?? DEFAULT_PROMPT_ID}
                onChange={(event) => void selectPrompt(profile.id, event.target.value)}
              >
                <option value={DEFAULT_PROMPT_ID}>{DEFAULT_PROMPT_NAME}</option>
                {settings.customPrompts.map((prompt) => (
                  <option key={prompt.id} value={prompt.id}>
                    {prompt.name}
                  </option>
                ))}
              </select>
              <span>Using {promptName(settings, profile.id)}</span>
            </>
            <button
              type="button"
              data-testid={`profile-activate-${profile.id}`}
              aria-disabled={session.active || profile.id === activeProfileId || undefined}
              onClick={() => void activate(profile.id)}
            >
              Switch to this profile
            </button>
            <button
              type="button"
              id={deleteButtonId(profile.id)}
              data-testid={`profile-delete-${profile.id}`}
              aria-disabled={session.active || undefined}
              onClick={() => void askToDelete(profile)}
            >
              Delete profile
            </button>
          </li>
        ))}
      </ul>

      {pendingDelete ? (
        <div
          ref={dialog}
          role="alertdialog"
          aria-labelledby="delete-confirm-heading"
          aria-describedby="delete-confirm-counts"
          data-testid="delete-confirm"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeDelete(deleteButtonId(pendingDelete.profile.id));
          }}
        >
          <h3 id="delete-confirm-heading">Delete {pendingDelete.profile.name}?</h3>
          <p id="delete-confirm-counts" data-testid="delete-confirm-counts">
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
            aria-disabled={session.active || undefined}
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
            onClick={() => closeDelete(deleteButtonId(pendingDelete.profile.id))}
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
        onDragLeave={(e) => {
          if (dragLeftZone(e.currentTarget, e.relatedTarget)) setDropTarget(false);
        }}
        onDrop={onDrop}
      >
        <p>Drag Markdown, PDF or Word files here to add them to this profile.</p>
        <button
          type="button"
          data-testid="pick-files"
          aria-disabled={!active || undefined}
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
  const ensuring = useInFlight();
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
        // The live percent is on screen, and a quarter step is what is read
        // out: a change inside `aria-hidden` is not in the accessibility tree,
        // so it does not make this status region speak.
        <p>
          Downloading the local embedding model:{' '}
          <span aria-hidden="true">{Math.round(model.percent)}</span>
          <span className="visually-hidden">{announcedPercent(model.percent)}</span> percent.
        </p>
      ) : null}
      {model.kind === 'unavailable' ? <p>{model.reason}</p> : null}
      {error ? (
        <p role="alert" data-testid="model-gate-error">
          {error}
        </p>
      ) : null}
      {/*
        Kept on screen while the download runs, unavailable. It used to be
        removed then, and the press that started the download left focus on a
        button that no longer existed.
      */}
      <button
        type="button"
        data-testid="model-retry"
        aria-disabled={ensuring.busy || model.kind === 'downloading' || undefined}
        onClick={() => {
          if (model.kind === 'downloading') return;
          void ensuring.run(async () => {
            setError(null);
            // The outcome arrives on `CH-214` when the call gets that far. An
            // `IpcError` never reaches that channel, so ignoring this result
            // re-enabled the button and said nothing at all.
            const result = await call('model:ensure');
            if (!result.ok) setError(result.message);
          });
        }}
      >
        Download the model now
      </button>
    </div>
  );
}

const HEADING_ID = 'company-profiles-heading';

/** A row's Delete profile button, where focus returns from its dialog. */
function deleteButtonId(profileId: string): string {
  return `profile-delete-button-${profileId}`;
}

/**
 * Whether a `dragleave` on the drop zone means the drag has left it (TASK-050,
 * ADR-037).
 *
 * `dragleave` also fires on the zone when the pointer crosses onto one of its
 * own children, with that child as `relatedTarget`. Clearing the highlight on
 * every one made it flicker off until the next `dragover` put it back. A drag
 * that leaves the window has no `relatedTarget`, and that is leaving.
 */
export function dragLeftZone(zone: Pick<Node, 'contains'>, next: EventTarget | null): boolean {
  return next === null || !zone.contains(next as Node);
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
  const retrying = useInFlight();
  const removing = useInFlight();
  const state = progress?.state ?? doc.state;

  /**
   * Every document action answers the same way: reload on success, show the
   * reason on failure. Written once, because three copies of the same
   * `.then` block is three places for the error branch to be dropped from.
   *
   * The two buttons each run behind an in-flight gate of their own. A fast
   * second click on Try again queued a second conversion pass behind the first,
   * and one on Remove document sent a delete for a row that was already gone.
   * They do not share one: a retry can take as long as the conversion, and
   * Remove document stays available during it, as it always was. The type
   * select is not gated at all, because arrow keys change a closed select one
   * value at a time and each change is a new intent.
   */
  const run = async <C extends 'doc:setType' | 'doc:retry' | 'doc:delete'>(
    channel: C,
    payload: Parameters<typeof call<C>>[1],
  ): Promise<void> => {
    setError(null);
    const result = await call(channel, payload);
    if (!result.ok) setError(result.message);
    else await onChanged();
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
          void run('doc:setType', {
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
            aria-disabled={retrying.busy || undefined}
            onClick={() =>
              void retrying.run(() => run('doc:retry', { docId: doc.id, profileId: doc.profileId }))
            }
          >
            Try again
          </button>
        </>
      ) : null}

      <button
        type="button"
        data-testid={`document-delete-${doc.id}`}
        aria-disabled={removing.busy || undefined}
        onClick={() =>
          void removing.run(() => run('doc:delete', { docId: doc.id, profileId: doc.profileId }))
        }
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
