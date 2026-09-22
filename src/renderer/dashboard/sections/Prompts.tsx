import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  DEFAULT_PROMPT_ID,
  DEFAULT_PROMPT_NAME,
  MAX_CUSTOM_PROMPTS,
  MAX_PROMPT_NAME_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  SHIPPED_SYSTEM_PROMPT,
} from '../../../shared/prompts.js';
import type { CustomPrompt, Profile, Settings } from '../../../shared/types.js';
import { call } from '../call.js';

interface PromptsProps {
  settings: Settings;
  profiles: Profile[];
  activeProfileId: string;
  onSettingsChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}

export function Prompts({
  settings,
  profiles,
  activeProfileId,
  onSettingsChanged,
  onDirtyChange,
}: PromptsProps): JSX.Element {
  const [selectedId, setSelectedId] = useState(DEFAULT_PROMPT_ID);
  const selected = settings.customPrompts.find((prompt) => prompt.id === selectedId) ?? null;
  const [name, setName] = useState(DEFAULT_PROMPT_NAME);
  const [text, setText] = useState(SHIPPED_SYSTEM_PROMPT);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // One library write at a time. Every mutation rebuilds the whole array from
  // the `settings` prop, so a second click before the first `config:set`
  // answers would send a stale array and drop the first change.
  const [busy, setBusy] = useState(false);

  const dirty = selected
    ? name !== selected.name || text !== selected.systemPrompt
    : name !== DEFAULT_PROMPT_NAME || text !== SHIPPED_SYSTEM_PROMPT;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (selectedId === DEFAULT_PROMPT_ID || selected) return;
    setSelectedId(DEFAULT_PROMPT_ID);
    setName(DEFAULT_PROMPT_NAME);
    setText(SHIPPED_SYSTEM_PROMPT);
  }, [selected, selectedId]);
  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent): void => {
      if (!dirty) return;
      // Electron forwards this refusal to main's `will-prevent-unload` handler,
      // which owns the native confirmation for reloads (CH-132).
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    void call('dashboard:setPromptDirty', { dirty });
    return () => {
      window.removeEventListener('beforeunload', preventUnload);
      void call('dashboard:setPromptDirty', { dirty: false });
    };
  }, [dirty]);

  const affectedProfiles = useMemo(
    () => profiles.filter((profile) => settings.profilePromptIds[profile.id] === selectedId),
    [profiles, selectedId, settings.profilePromptIds],
  );
  const activeSelection = settings.profilePromptIds[activeProfileId] ?? DEFAULT_PROMPT_ID;

  function load(id: string): void {
    if (dirty && !window.confirm('Discard the unsaved prompt changes?')) return;
    const prompt = settings.customPrompts.find((item) => item.id === id);
    setSelectedId(prompt?.id ?? DEFAULT_PROMPT_ID);
    setName(prompt?.name ?? DEFAULT_PROMPT_NAME);
    setText(prompt?.systemPrompt ?? SHIPPED_SYSTEM_PROMPT);
    setError(null);
    setStatus(null);
  }

  function validate(): string | null {
    const trimmedName = name.trim();
    if (!trimmedName) return 'Give the prompt a name.';
    if (trimmedName.toLocaleLowerCase() === DEFAULT_PROMPT_NAME.toLocaleLowerCase())
      return `${DEFAULT_PROMPT_NAME} is reserved for the shipped prompt.`;
    if (trimmedName.length > MAX_PROMPT_NAME_CHARS)
      return `The name must be ${MAX_PROMPT_NAME_CHARS} characters or fewer.`;
    if (!text.trim()) return 'The system prompt cannot be blank.';
    if (text.length > MAX_SYSTEM_PROMPT_CHARS)
      return `The system prompt must be ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} characters or fewer.`;
    const duplicate = settings.customPrompts.some(
      (prompt) =>
        prompt.id !== selectedId &&
        prompt.name.trim().toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
    );
    return duplicate ? 'Prompt names must be unique.' : null;
  }

  async function write(
    customPrompts: CustomPrompt[],
    profilePromptIds = settings.profilePromptIds,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      const result = await call('config:set', { customPrompts, profilePromptIds });
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      await onSettingsChanged();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!selected) return;
    setError(null);
    const problem = validate();
    if (problem) return setError(problem);
    if (
      affectedProfiles.length > 0 &&
      !window.confirm(
        `Save changes for ${affectedProfiles.map((profile) => profile.name).join(', ')}?`,
      )
    )
      return;
    const trimmedName = name.trim();
    const next = settings.customPrompts.map((prompt) =>
      prompt.id === selected.id ? { ...prompt, name: trimmedName, systemPrompt: text } : prompt,
    );
    if (await write(next)) {
      // Match the persisted value, or `dirty` stays true and the editor keeps
      // warning about changes that were saved.
      setName(trimmedName);
      setStatus('Prompt saved. Changes apply to the next session.');
    }
  }

  async function create(copyDefault = false): Promise<void> {
    if (busy || settings.customPrompts.length >= MAX_CUSTOM_PROMPTS) return;
    const id = crypto.randomUUID();
    const base = copyDefault ? 'Copy of Default prompt' : 'Custom prompt';
    const existing = new Set(
      settings.customPrompts.map((prompt) => prompt.name.toLocaleLowerCase()),
    );
    let nextName = base;
    let suffix = 2;
    while (existing.has(nextName.toLocaleLowerCase())) nextName = `${base} ${suffix++}`;
    const prompt: CustomPrompt = {
      id,
      name: nextName,
      systemPrompt: copyDefault ? SHIPPED_SYSTEM_PROMPT : text,
    };
    if (await write([...settings.customPrompts, prompt])) {
      setSelectedId(id);
      setName(prompt.name);
      setText(prompt.systemPrompt);
      setStatus('Custom prompt created.');
    }
  }

  async function duplicate(): Promise<void> {
    if (busy || !selected || settings.customPrompts.length >= MAX_CUSTOM_PROMPTS) return;
    setError(null);
    const problem = validate();
    if (problem) return setError(problem);
    const id = crypto.randomUUID();
    // The copy carries the draft, not the last saved text, so duplicating is
    // never a silent way to lose the edit on screen.
    const base = `Copy of ${name.trim()}`.slice(0, MAX_PROMPT_NAME_CHARS - 3);
    let nextName = base;
    let suffix = 2;
    const existing = new Set(
      settings.customPrompts.map((prompt) => prompt.name.toLocaleLowerCase()),
    );
    while (existing.has(nextName.toLocaleLowerCase())) nextName = `${base} ${suffix++}`;
    const prompt = { id, name: nextName, systemPrompt: text };
    if (await write([...settings.customPrompts, prompt])) {
      setSelectedId(id);
      setName(prompt.name);
      setText(prompt.systemPrompt);
      setStatus('Prompt duplicated.');
    }
  }

  async function useForProfile(): Promise<void> {
    if (!activeProfileId) return;
    setError(null);
    const profilePromptIds = { ...settings.profilePromptIds };
    if (selectedId === DEFAULT_PROMPT_ID) delete profilePromptIds[activeProfileId];
    else profilePromptIds[activeProfileId] = selectedId;
    if (await write(settings.customPrompts, profilePromptIds))
      setStatus('Prompt selected for the active profile.');
  }

  async function remove(): Promise<void> {
    if (!selected) return;
    const names = affectedProfiles.map((profile) => profile.name).join(', ');
    const message = names
      ? `Delete this prompt? These profiles will return to Default prompt: ${names}.`
      : 'Delete this prompt?';
    if (!window.confirm(message)) return;
    const profilePromptIds = { ...settings.profilePromptIds };
    for (const profile of affectedProfiles) delete profilePromptIds[profile.id];
    if (
      await write(
        settings.customPrompts.filter((prompt) => prompt.id !== selected.id),
        profilePromptIds,
      )
    ) {
      setSelectedId(DEFAULT_PROMPT_ID);
      setName(DEFAULT_PROMPT_NAME);
      setText(SHIPPED_SYSTEM_PROMPT);
      setStatus('Prompt deleted. Affected profiles now use Default prompt.');
    }
  }

  return (
    <section
      className="prompt-editor"
      data-testid="section-prompts"
      aria-labelledby="prompts-heading"
    >
      <h2 id="prompts-heading">Prompts</h2>
      <p>View and customize the instructions used to create live suggestions.</p>
      <label htmlFor="prompt-preset">Prompt preset</label>
      <select
        id="prompt-preset"
        data-testid="prompt-preset"
        value={selectedId}
        onChange={(event) => load(event.target.value)}
      >
        <option value={DEFAULT_PROMPT_ID}>{DEFAULT_PROMPT_NAME}</option>
        {settings.customPrompts.map((prompt) => (
          <option key={prompt.id} value={prompt.id}>
            {prompt.name}
          </option>
        ))}
      </select>
      <p role="status" data-testid="prompt-limit">
        {settings.customPrompts.length} of {MAX_CUSTOM_PROMPTS} custom prompts saved.
      </p>

      <label htmlFor="prompt-name">Prompt name</label>
      <input
        id="prompt-name"
        data-testid="prompt-name"
        maxLength={MAX_PROMPT_NAME_CHARS}
        value={name}
        disabled={!selected}
        onChange={(event) => setName(event.target.value)}
      />
      <label htmlFor="prompt-text">System prompt</label>
      <textarea
        id="prompt-text"
        data-testid="prompt-text"
        rows={16}
        value={text}
        readOnly={!selected}
        onChange={(event) => setText(event.target.value)}
      />
      <p data-testid="prompt-character-count">
        {text.length.toLocaleString()} of {MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} characters
      </p>
      {dirty ? <p role="status">Unsaved changes.</p> : null}
      {error ? (
        <p role="alert" data-testid="prompt-error">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" data-testid="prompt-status">
          {status}
        </p>
      ) : null}

      <button
        type="button"
        data-testid="prompt-create"
        disabled={busy || settings.customPrompts.length >= MAX_CUSTOM_PROMPTS}
        onClick={() => void create(!selected)}
      >
        Create custom prompt
      </button>
      <button
        type="button"
        data-testid="prompt-save"
        disabled={busy || !selected || !dirty}
        onClick={() => void save()}
      >
        Save
      </button>
      <button
        type="button"
        data-testid="prompt-duplicate"
        disabled={busy || !selected || settings.customPrompts.length >= MAX_CUSTOM_PROMPTS}
        onClick={() => void duplicate()}
      >
        Duplicate
      </button>
      <button
        type="button"
        className="secondary-button"
        data-testid="prompt-restore"
        disabled={!selected}
        onClick={() => setText(SHIPPED_SYSTEM_PROMPT)}
      >
        Restore default text
      </button>
      <button
        type="button"
        className="secondary-button"
        data-testid="prompt-delete"
        disabled={busy || !selected}
        onClick={() => void remove()}
      >
        Delete
      </button>

      <h3>Active company profile</h3>
      <p>
        {profiles.find((profile) => profile.id === activeProfileId)?.name ??
          'No company profile is active.'}
      </p>
      <button
        type="button"
        data-testid="prompt-use-for-profile"
        disabled={busy || !activeProfileId || activeSelection === selectedId}
        onClick={() => void useForProfile()}
      >
        Use for this profile
      </button>
      {activeProfileId ? (
        <p>
          Currently selected:{' '}
          {activeSelection === DEFAULT_PROMPT_ID
            ? DEFAULT_PROMPT_NAME
            : (settings.customPrompts.find((prompt) => prompt.id === activeSelection)?.name ??
              DEFAULT_PROMPT_NAME)}
          .
        </p>
      ) : null}
    </section>
  );
}
