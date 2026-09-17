/**
 * Consent Reminder (FR-007, FR-032, FR-087, FR-110).
 *
 * Editable, with a one-action reset to the shipped default. The default is
 * imported from `shared/defaults.ts` rather than repeated here, so the text the
 * reset writes is the text the app ships and the two cannot drift.
 */
import { useEffect, useState, type JSX } from 'react';
import { DEFAULT_CONSENT_REMINDER_TEXT } from '../../../shared/defaults.js';
import type { Settings } from '../../../shared/types.js';
import { call } from '../call.js';

export interface ConsentReminderProps {
  settings: Settings;
  onSettingsChanged: () => Promise<void>;
}

export function ConsentReminder({
  settings,
  onSettingsChanged,
}: ConsentReminderProps): JSX.Element {
  const [text, setText] = useState(settings.consentReminderText);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setText(settings.consentReminderText), [settings.consentReminderText]);

  async function write(next: string): Promise<void> {
    setError(null);
    setSaved(false);
    const result = await call('config:set', { consentReminderText: next });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSaved(true);
    await onSettingsChanged();
  }

  return (
    <section data-testid="section-consent-reminder" aria-labelledby="consent-heading">
      <h2 id="consent-heading">Consent Reminder</h2>
      <p>
        The overlay shows this before the first suggestion of every session. Telling your
        interviewer that you use an accessibility aid is your call and your responsibility.
      </p>

      <label htmlFor="consent-text">Reminder text</label>
      <textarea
        id="consent-text"
        data-testid="consent-text"
        rows={5}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // "Saved" belonged to the text that was saved. Left standing beside an
          // edit, it told the user the overlay would show wording the main
          // process has never been given.
          setSaved(false);
        }}
      />

      <button type="button" data-testid="consent-save" onClick={() => void write(text)}>
        Save reminder
      </button>
      <button
        type="button"
        data-testid="consent-reset"
        onClick={() => {
          // One action, as FR-032 requires: the field and the stored setting
          // both go back to the shipped default on this single press.
          setText(DEFAULT_CONSENT_REMINDER_TEXT);
          void write(DEFAULT_CONSENT_REMINDER_TEXT);
        }}
      >
        Reset to the shipped default
      </button>
      {saved ? <span data-testid="consent-saved">Saved</span> : null}
      {error ? (
        <span role="alert" data-testid="consent-error">
          {error}
        </span>
      ) : null}

      <p data-testid="consent-default-preview">
        The shipped default states that an unencrypted local text transcript is kept for the
        session: {DEFAULT_CONSENT_REMINDER_TEXT}
      </p>
    </section>
  );
}
