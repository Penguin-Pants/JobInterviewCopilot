/**
 * Hotkeys (FR-030, FR-087).
 *
 * A binding another application already owns is rejected by the main process
 * and the previous binding is restored there, so this section shows the reason
 * inline and puts the field back to what is actually registered. It never keeps
 * a binding on screen that is not the one in force.
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { Settings } from '../../../shared/types.js';
import { call } from '../call.js';
import { useInFlight } from '../inFlight.js';

type Action = 'toggleInteraction' | 'togglePause';

const ACTIONS: { action: Action; label: string }[] = [
  { action: 'toggleInteraction', label: 'Make the overlay interactive or click-through' },
  { action: 'togglePause', label: 'Pause or resume suggestions' },
];

/**
 * Build an Electron accelerator from a key press.
 *
 * Returns null for a press that is only modifiers, so holding Control alone
 * does not register a binding no key can ever produce.
 */
export function acceleratorFrom(event: {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): string | null {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');

  const key = event.key;
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return null;
  if (key === ' ') parts.push('Space');
  else if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key);

  return parts.join('+');
}

/**
 * The draft with one action put back to its stored binding (FR-030).
 *
 * A refused rebind replaced the whole draft, which threw away the other
 * action's captured but unapplied combination, the same loss the sync effect
 * below was written to prevent.
 */
export function withStoredBinding(
  draft: Settings['hotkeys'],
  stored: Settings['hotkeys'],
  action: Action,
): Settings['hotkeys'] {
  return { ...draft, [action]: stored[action] };
}

export interface HotkeysProps {
  settings: Settings;
  onSettingsChanged: () => Promise<void>;
}

export function Hotkeys({ settings, onSettingsChanged }: HotkeysProps): JSX.Element {
  const [draft, setDraft] = useState(settings.hotkeys);
  const [errors, setErrors] = useState<Partial<Record<Action, string>>>({});
  const [applied, setApplied] = useState<Partial<Record<Action, boolean>>>({});
  // One gate for both actions. They share the draft and the reload after a
  // rebind, and nothing needs two rebinds in flight at once.
  const applying = useInFlight();

  // Keyed on the value. `config:get` answers with a fresh object every time, so
  // depending on the object identity threw away a captured but unapplied
  // combination whenever any other section saved anything.
  //
  // Only the actions the user has not captured are synced. Replacing the whole
  // draft threw the other action's captured-but-unapplied combination away the
  // moment either one was applied, because applying reloads the settings.
  const dirty = useRef<Partial<Record<Action, true>>>({});
  const storedHotkeys = JSON.stringify(settings.hotkeys);
  useEffect(() => {
    const stored = JSON.parse(storedHotkeys) as Settings['hotkeys'];
    setDraft((current) => ({
      toggleInteraction: dirty.current.toggleInteraction
        ? current.toggleInteraction
        : stored.toggleInteraction,
      togglePause: dirty.current.togglePause ? current.togglePause : stored.togglePause,
    }));
  }, [storedHotkeys]);

  async function apply(action: Action): Promise<void> {
    setApplied((a) => ({ ...a, [action]: false }));
    const accelerator = draft[action];
    const result = await call('hotkey:rebind', { action, accelerator });
    delete dirty.current[action];
    if (!result.ok) {
      setErrors((e) => ({ ...e, [action]: result.message }));
      setDraft((d) => withStoredBinding(d, settings.hotkeys, action));
      return;
    }
    const response = result.value;
    if ('error' in response) {
      setErrors((e) => ({ ...e, [action]: response.error }));
      // The main process kept the old binding. Showing the rejected text would
      // leave the user believing a hotkey is bound that is not (FR-030).
      setDraft((d) => withStoredBinding(d, settings.hotkeys, action));
      return;
    }
    setErrors((e) => ({ ...e, [action]: undefined }));
    setApplied((a) => ({ ...a, [action]: true }));
    await onSettingsChanged();
  }

  function capture(action: Action, event: KeyboardEvent<HTMLInputElement>): void {
    // Tab must keep moving focus, or the field would be a keyboard trap
    // (NFR-010). Escape leaves the current binding alone.
    if (event.key === 'Tab' || event.key === 'Escape') return;
    event.preventDefault();
    const accelerator = acceleratorFrom(event);
    if (!accelerator) return;
    setDraft((d) => ({ ...d, [action]: accelerator }));
    dirty.current[action] = true;
    // The verdict belonged to the combination that was applied, not to this
    // one. Left standing, "Bound" sat next to an unapplied combination, which
    // is the UI asserting a binding that is not registered: the one thing this
    // section exists to prevent.
    setApplied((a) => ({ ...a, [action]: false }));
    setErrors((e) => ({ ...e, [action]: undefined }));
  }

  return (
    <section data-testid="section-hotkeys" aria-labelledby="hotkeys-heading">
      <h2 id="hotkeys-heading">Hotkeys</h2>
      <p>
        Focus a field and press the combination you want. A combination another application already
        owns is refused and the previous binding stays in force.
      </p>
      <ul className="rows">
        {ACTIONS.map(({ action, label }) => (
          <li key={action}>
            <label htmlFor={`hotkey-${action}`}>{label}</label>
            <input
              id={`hotkey-${action}`}
              data-testid={`hotkey-${action}`}
              value={draft[action]}
              readOnly
              onKeyDown={(event) => capture(action, event)}
            />
            <button
              type="button"
              data-testid={`hotkey-apply-${action}`}
              aria-disabled={applying.busy || undefined}
              onClick={() => void applying.run(() => apply(action))}
            >
              Apply
            </button>
            {/* Mounted before its text, so the change is announced. */}
            <span role="status">
              {applied[action] ? <span data-testid={`hotkey-applied-${action}`}>Bound</span> : null}
            </span>
            {errors[action] ? (
              <span role="alert" data-testid={`hotkey-error-${action}`}>
                {errors[action]}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
