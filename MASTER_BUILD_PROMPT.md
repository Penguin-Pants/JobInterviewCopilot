# Interview CoPilot — Master Build Prompt

> **Status.** This file is the product brief. It is no longer the build
> specification. The implementation baseline is `docs/`, starting with
> `docs/00-decision-log.md`. Where this file and `docs/` disagree, `docs/` wins.
> Three contradictions in the original brief were resolved on 2026-09-15 and the
> text below has been corrected to match (ADR-001, ADR-003). A fourth divergence,
> found in review, is corrected in section 3: audio capture cannot run in the
> main process (ADR-005). Sections 2 and 4 are corrected for the provider
> registry (ADR-022), which supersedes the two-way STT choice in the original.
## 0. Product Summary

Interview CoPilot is a native Windows desktop app. It gives a job candidate real-time, glanceable prompts during a live video interview, pulled from the candidate's own resume, company and job research and other notes. The primary goal is accessibility support, for example ADHD or memory recall under stress, not scripted deception.

**Hard guardrails. Do not build around these:**
- The overlay window should be excluded from screen-share or recording capture because it could interfere with the interviewee presenting a presentation, business case etc. Consent has already been given.
- The app must show a consent reminder before each live session. The interviewer's awareness of the tool is the user's responsibility. The app supports that responsibility, it does not hide from it.
- Audio is never written to disk. Only text transcripts are persisted. The user controls retention and can delete any transcript at any time (ADR-003).

## 1. Tech Stack
- Electron, TypeScript, React, Tailwind CSS.
- Magic UI components, Framer Motion for animation.
- Target: Windows 10 and 11 desktop, native build via electron-builder.

## 2. Configuration Architecture — `/src/main/config.ts`
- Use `electron-store` for all non-secret settings.
- Use Electron `safeStorage` (Windows DPAPI backing) for API keys specifically. Never write raw keys into the electron-store JSON file.
- Independent provider config, each with a primary and an optional backup:
  - **Corrected (ADR-022).** STT and LLM are data-driven provider registries. The user picks a provider **and a model** for primary and optional backup. STT ships Deepgram (`nova-3`, `nova-2`), OpenAI (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and `whisper-1` as a labeled non-streaming option) and ElevenLabs (`scribe-v2-realtime`). LLM ships Anthropic and OpenAI. Adding a provider costs one registry entry plus one adapter.
- Validate each key on entry with a lightweight live test call before saving. Show an inline pass or fail result.
- Company profiles: each profile stores a name, its own knowledge base documents and its own session history.
- Theme settings: light, dark or follow-system; accent color; overlay translucency mode (acrylic blur or flat opacity) and opacity level.
- Hotkey bindings, defaults listed in section 8, user-rebindable in the Dashboard.
- Cost and time thresholds for the session usage warning.
- Editable consent reminder text template.

## 3. Windows Dual-Stream Audio Capture — `/src/main/audio.ts` and a hidden renderer
This diverges from the original draft: capture two independent streams, never mixed.

**Corrected (ADR-005).** Neither WASAPI loopback nor `getUserMedia` is reachable from the Electron main process. The capture itself runs in a hidden renderer, the Audio Worker. `/src/main/audio.ts` keeps its name and becomes the supervisor: it creates the worker, starts and stops streams, tracks health and re-emits tagged chunks.

- Interviewer stream: WASAPI loopback via `electron-audio-loopback`, system audio only. This is all system audio, not the interviewer alone. Music and notifications land on this stream too, which is a documented v1 limitation (ADR-021).
- Candidate stream: local microphone input.
- Down-sample each stream independently to 16kHz, 16-bit, mono linear PCM.
- Emit chunks every 1000 ms per stream, fixed (ADR-007), short chunks to support the fast-latency target from section 7. Tag every chunk with its source: `interviewer` or `candidate`.
- Never write raw audio to disk. Buffers exist in memory only and are discarded once transcribed.

## 4. Multi-Provider Transcription Pipeline — `/src/main/ai/stt.ts`
- One unified STT interface. Instantiate it once per stream (interviewer, candidate), so each stream keeps its own connection and its own partial and final transcript state.
- Route to the adapter named by the active `ProviderChoice` in the registry (ADR-022). Capability flags come from the selected model's registry entry, never from a provider name.
- On a call failure or timeout: if a backup provider is configured, retry against it automatically and keep going. If no backup is configured, retry the primary in the background and surface a small, quiet status badge in the Dashboard, never an overlay error card.
- Emit a normalized event for both streams: `{ source: 'interviewer' | 'candidate', text: string, isFinal: boolean, timestamp }`.

## 5. Turn Detection And Trigger Logic — `/src/main/ai/trigger.ts`
New module, needed because suggestions must react only to the interviewer, automatically.

- Watch the `interviewer` transcript stream for a completed turn: a silence gap of roughly 700 to 900 milliseconds after a final transcript segment, or a provider-native endpointing signal if available.
- On a detected turn end, fire a `generate-suggestion` event carrying the interviewer's latest question text.
- Keep a rolling window of recent `candidate` transcript text as context only, so the LLM does not repeat something the user already said. The candidate stream never fires a `generate-suggestion` event.
- A global hotkey, default `Ctrl+Shift+P`, pauses and resumes this trigger without closing the app or the audio pipeline. Useful for small talk or breaks.
- If a new turn end fires while a suggestion is still streaming, cancel the in-flight generation and start fresh on the newest question. A stale answer to an old question is not useful.

## 6. Local Embedding RAG Engine — `/src/main/rag.ts`
- Ingest `.md` natively. Auto-convert `.pdf` and `.docx` to Markdown on import, for example `pdf-parse` for PDF text extraction and `mammoth` for DOCX. Flag to the user that PDF text extraction is best-effort. PDFs do not carry real header semantics, so structure detection may be rough. Fall back to a single synthetic `# Resume` wrapper when no clear headers are found.
- Every document belongs to exactly one company profile.
- On upload, auto-tag each document as `resume`, `company-notes` or `job-description`, guessed from filename and content. Let the user override the tag in the Dashboard.
- Chunk Markdown by headers (`#`, `##`, `###`). Cap chunk size at roughly 500 tokens, soft-splitting oversized sections on paragraph breaks. Store chunk metadata: `{ sourceFile, headerPath, docType, profileId }`.
- Embed locally with `@xenova/transformers`, model `all-MiniLM-L6-v2`. On first run, show a one-time "downloading local AI model" indicator, roughly 90MB.
- Cache embeddings to disk, keyed by file hash. Skip recompute for unchanged files on relaunch.
- Watch each profile's knowledge base folder, for example with `chokidar`. Any add, edit or delete triggers automatic re-embedding of just that file, within a few seconds.
- Query function: cosine similarity, top 3 chunks, scoped to the active company profile. Ship v1 as plain similarity search across the profile's tagged pool. Doc-type-weighted retrieval, for example favoring `resume` chunks for personal-experience questions, is a v2 enhancement. Do not build it into v1.

## 7. LLM Streaming Suggestion Pipeline — `/src/main/ai/llm.ts`
- One unified interface for Anthropic and OpenAI, mirroring the STT primary and backup failover behavior in section 4.
- On a `generate-suggestion` event, build a prompt from: the interviewer's latest question, recent candidate context and the top 3 RAG matches with their doc-type labels.
- Instruct the model explicitly to answer in short cue form: 3 to 5 short bullet points, keywords or STAR-method reminders. Never a full scripted paragraph the user would read verbatim.
- Default to a fast, low-cost model per provider, for example a Claude Haiku class model or a GPT-4o-mini class model, configurable in the Dashboard.
- Stream tokens over IPC to the overlay window. Buffer them in the main process and flush once per completed bullet or line, not per token or character. This is a hard requirement carried from the original draft. It prevents the text-crawl effect.
- On failure: the same silent-retry and backup-failover behavior as section 4. The overlay never shows a disruptive error card.

## 8. Window Orchestrator And IPC — `/src/main/index.ts`

### Dashboard window
Standard window, resizable, follows the light, dark or system theme setting. Sections:
- Provider Setup: STT and LLM primary and backup pickers, key entry with live validation.
- Company Profiles: create, switch and delete profiles. Drag-and-drop knowledge base manager per profile, with doc-type tag override.
- Session History: grouped by company profile. View and delete past text transcripts.
- Hotkeys: rebind the interaction toggle and the pause and resume trigger.
- Cost And Usage: running session timer, estimated spend, editable warning threshold.
- Consent Reminder: editable text template shown before each live session.

### Teleprompter overlay window
- `transparent: true`, `frame: false`, `alwaysOnTop: true`, `skipTaskbar: true`.
- Excluded from screen capture via `setContentProtection(true)`, applied before the window is first shown and never disabled (ADR-001). The overlay stays visible on the physical display. This protects a shared presentation from being covered, it is not a way to hide the tool from the interviewer. That responsibility sits with the consent reminder.
- Fixed size, not resizable. The user drags it anywhere, including across monitors. Remember the last position and monitor in `electron-store`.
- Default to click-through: `win.setIgnoreMouseEvents(true, { forward: true })`.
- Global hotkey, default `Ctrl+Shift+I`, toggles between click-through mode and movable, interactive mode.
- Translucency mode (acrylic blur, for example via a native Windows blur module, or flat CSS opacity) and the exact opacity level both come from the theme settings in section 2.
- Before the first suggestion of a live session, show the consent reminder text as a brief, dismissible, non-blocking prompt. It is not logged or verified. It is a reminder screen only. Its default copy should state plainly that a local text transcript is kept for this session, matching section 10's logging behavior.

## 9. Teleprompter Frontend UX — `/src/renderer/Overlay.tsx`
- Idle state: a small, quiet translucent card reading a standing-by status message. Shown before the first suggestion, and whenever the trigger is paused.
- Active state: a fixed stack of the 2 to 3 most recent suggestion cards. When a new one arrives, the oldest fades out, using Framer Motion `AnimatePresence`.
- Reveal animation: fade in combined with a slight upward slide, roughly 200 to 300 milliseconds, applied once per completed bullet or line as it arrives from the buffered stream in section 7. Do not use a per-word reveal. It reads too slowly for short cue-style bullets.
- Text: large by default, 20 to 24 pixels, high contrast, live-adjustable in the Dashboard or with an in-overlay control.
- Build the cards with Magic UI components on top of Tailwind, styled from the theme tokens in section 2: light, dark or system; accent color; opacity.

## 10. Failure And Edge Case Handling
- STT or LLM failure: silent retry, automatic backup-provider failover when configured, quiet Dashboard status badge only. Never an overlay error card.
- No speech for an extended period: the idle standing-by card just persists. This is not an error state.
- Session logging: keep a local text transcript (interviewer and candidate turns, plus generated suggestions) per session, grouped under its company profile in Session History. Text only, never audio. Kept until the user deletes it.
- Session cost guard: show the running timer and spend estimate at all times during a live session. Warn once past the configured threshold. Do not hard-stop the session. The user chose a warning, not an automatic cutoff.
- Credential errors: validate on entry per section 2. If a previously valid key starts failing mid-session, treat it as a provider failure, handled per the first bullet above.

## 11. Explicit Non-Goals
Carried forward from product discovery. Do not add these later without a new, explicit decision:
- No hidden or silently-skippable consent step.
- No persistent audio recording, of either stream, under any setting.

## Defaults Chosen Without A Direct Question
Flag any of these for a change before this goes to build:
- Chunk cap of roughly 500 tokens for RAG chunking.
- Default hotkeys: `Ctrl+Shift+I` for the interaction toggle, `Ctrl+Shift+P` for pause and resume.
- Default fast, low-cost model picks per provider.
- Cancel-and-restart behavior when a new question arrives mid-stream.
- `skipTaskbar: true` on the overlay window. A normal utility-window convention, unrelated to the capture-exclusion guardrail.
- Doc-type-weighted retrieval deferred to v2. V1 ships as plain similarity search.

The full assumption register, with the cost to change each item, is in
`docs/00-decision-log.md` section 4.
