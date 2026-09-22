# Feature request: Custom suggestion prompts

## Summary

Add a **Prompts** tab to the Dashboard where the user can view and customize the
system prompt that instructs the selected language model when it creates live
interview suggestions.

The shipped suggestion prompt remains the default and is always available. The
user may save up to five custom prompt presets. Each company profile selects
which preset it uses, so different companies can use different instructions.

## Problem

The suggestion prompt is currently fixed and hidden from the user. This makes
it impossible to inspect the instructions behind Copilot's suggestions or tune
the style and focus for a particular interview or company.

## Scope decisions

- This feature applies only to the system prompt used to generate live
  suggestions.
- It does not change the actionability-classification prompt, the question and
  context template, model settings, generation limits, or the enforced shape
  and safety rules for suggestion cards.
- Prompt presets are shared across the application. A company profile stores
  only its selected preset, rather than keeping a separate duplicate library.
- The shipped default does not count toward the limit of five custom presets.
- The prompt selected for a session is fixed when that session starts, just as
  the company profile is. Changes made during a session apply to the next
  session.

These decisions avoid two overlapping prompt systems while still allowing each
company profile to behave differently.

## User experience

### Prompts tab

Add a **Prompts** item to the Dashboard navigation. The tab must include:

1. A list containing **Default prompt** and up to five custom prompt presets.
2. A clear indication of which prompt is selected for the active company
   profile.
3. The preset name and full system prompt in an editable text area.
4. Actions to create, save, duplicate, rename, and delete a custom preset.
5. A **Use for this profile** action.
6. A **Restore default text** action for custom presets.
7. A visible unsaved-changes state and a warning before switching presets,
   changing tabs, or closing the window when edits would be lost.

The shipped default prompt must be readable but not directly editable. Editing
or duplicating it creates a custom preset, preventing the original from being
lost. **Restore default text** replaces the current custom draft with the
shipped default text and still requires the user to save.

If no company profile exists, prompt presets can still be managed, but the
profile selection action is disabled with a short explanation.

### Company profiles

The Company Profiles experience must show the prompt selected for each profile
and allow it to be changed. The same selection must also be available from the
Prompts tab when that profile is active.

New profiles use **Default prompt**. Deleting a custom preset that is assigned
to one or more profiles requires confirmation that names the affected profiles.
After confirmation, those profiles return to **Default prompt**.

Editing a custom preset affects every profile that uses it. Before saving such
an edit, the interface must state which profiles will be affected.

## Default prompt

The initial default must be the exact suggestion prompt shipped at the time
this feature is introduced:

> You are a live interview memory aid for a candidate who has consented to
> using this tool. Answer with 3 to 5 very short bullets. Each bullet is at
> most 12 words. Use keywords, concrete facts from the candidate's notes,
> or STAR-method reminders (Situation, Task, Action, Result).
>
> Never write a paragraph. Never write a sentence the candidate could read
> aloud verbatim. You are producing cues, not a script.
>
> If the notes do not cover the question, say so in one bullet and give
> structural cues instead of invented facts. Never invent an employer,
> a date, a metric or a project that is not in the notes.

The interface and generation flow must read this default from one authoritative
source so the displayed and applied versions cannot drift. A future application
update may improve the shipped default without overwriting saved custom
presets.

## Functional requirements

1. The user can always view the complete shipped default prompt.
2. The user can save no more than five custom presets in total.
3. Each custom preset has a unique, non-empty name and non-empty prompt text.
4. Leading and trailing whitespace is ignored when validating a name, but the
   intentional formatting of the prompt text is preserved.
5. When five custom presets exist, creation and duplication are disabled and
   the interface explains the limit. Existing presets remain editable.
6. Exactly one prompt is selected for every company profile: the default or one
   saved custom preset.
7. Starting a session captures the active profile's current prompt selection
   and exact saved text for the lifetime of that session.
8. Both the primary and backup language models receive the same captured system
   prompt during a session.
9. Unsaved prompt text is never sent to a model.
10. Saving prompt content or changing a profile's selection persists across
    application restarts.
11. Restoring default text is reversible until saved. After it is saved, the
    custom preset remains a custom preset with its existing name.
12. The shipped default cannot be renamed or deleted.
13. Deleting a company profile does not delete shared prompt presets.
14. Prompt content must not be written to session transcripts or ordinary logs.
15. Existing installations migrate safely: existing profiles select the
    shipped default, and current suggestion behavior does not change until the
    user explicitly chooses a custom preset.

## Validation and error handling

- Reject a blank preset name or blank prompt with an inline, actionable error.
- Enforce a documented prompt-length limit that comfortably contains the
  shipped default and protects settings storage and provider requests. Show the
  limit and current usage near the editor.
- Reject duplicate preset names without regard to letter case.
- If saving or selecting a prompt fails, keep the user's draft, leave the last
  saved selection active, and show the error next to the attempted action.
- If persisted prompt data is invalid or references a missing preset, preserve
  the application's existing settings-recovery behavior and safely use the
  shipped default.
- Custom instructions do not bypass the existing output-shape enforcement,
  consent behavior, provider validation, or knowledge-grounding inputs.

## Accessibility

- The new tab follows the Dashboard's existing keyboard and tab behavior.
- Every field and action has a visible label and keyboard-accessible control.
- Selection, validation errors, save status, and preset-limit messages are
  announced to assistive technology without relying on color alone.

## Acceptance criteria

1. On an existing installation, opening **Prompts** shows the current shipped
   prompt and every existing profile uses it.
2. A user can create, name, edit, save, and select a custom preset for the active
   profile, restart the application, and see the same text and selection.
3. A suggestion generated in a new session uses the prompt selected for that
   session's company profile.
4. Two profiles can select different prompts, and switching the active profile
   changes the prompt used by the next session.
5. Changing a prompt selection or editing a preset during a live session does
   not alter that session, but does affect a later session.
6. The primary and backup model paths use the same selected prompt.
7. The application permits five custom presets and prevents a sixth without
   deleting or overwriting data.
8. The user can always recover the shipped text, even after every custom preset
   has been edited or deleted.
9. Deleting an assigned preset clearly identifies affected profiles and returns
   them to the default only after confirmation.
10. Blank names, duplicate names, blank prompts, and over-limit prompts cannot
    be saved and produce clear inline errors.
11. Cancelling navigation after an unsaved-changes warning preserves the draft;
    choosing to discard removes only the unsaved changes.
12. Existing suggestion formatting and safety enforcement still apply when a
    custom prompt asks for incompatible output.

## Out of scope

- More than five custom presets.
- Cloud sync, import, export, or sharing of presets.
- Separate prompt libraries for individual profiles.
- Editing the actionability classifier or the user-message template.
- Per-provider or per-model prompt variants.
- Editing generation parameters such as temperature or token limits.
- Prompt version history beyond the shipped default and the last saved value.

## Product question resolved by this request

“Change the system prompt for each company profile” is interpreted as selecting
one prompt from the shared library for each profile. This keeps the five-preset
limit understandable and avoids hidden profile-specific copies. If independent
prompt text per profile is desired instead, that should be decided before
implementation because it changes the storage model and the meaning of the
five-preset limit.
