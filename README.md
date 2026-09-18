# Interview CoPilot

A native Windows desktop app that gives a job candidate real-time, glanceable
cues during a live video interview, drawn from their own resume, company
research and notes. The purpose is accessibility support, for example ADHD or
memory recall under stress. It is not a scripting tool.

**Status: Milestones 0, 1 and 2 complete.** Foundations, audio and
transcription, and the knowledge base are implemented and verified. Milestone 3
(trigger and suggestions) is next. See `docs/03-tasks.md` for what each milestone
covers and what it deferred.

---

## Documents

Read them in this order. The decision log wins over every other document.

| Document | What it answers |
|---|---|
| [`docs/00-decision-log.md`](docs/00-decision-log.md) | Which way each contested question was settled, what is still an assumption, and what is still open |
| [`docs/01-requirements.md`](docs/01-requirements.md) | What the product must do, as 107 verifiable requirements |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Components, data model, interfaces, IPC contract, dependencies |
| [`docs/03-tasks.md`](docs/03-tasks.md) | 27 implementation tasks with binary acceptance criteria and the global Definition of Done |
| [`docs/04-test-strategy.md`](docs/04-test-strategy.md) | 133 automated test cases, 15 manual Windows checks, the CI pipeline |
| [`docs/07-release-checklist.md`](docs/07-release-checklist.md) | How a tag becomes an installer, and what blocks one |
| [`docs/06-verification-map.md`](docs/06-verification-map.md) | Hand-authored. One row per requirement naming the tests that actually prove it |
| [`docs/05-traceability.md`](docs/05-traceability.md) | Generated matrix. Do not edit |
| [`docs/OLD_MASTER_BUILD_PROMPT.md`](docs/OLD_MASTER_BUILD_PROMPT.md) | The original product brief, corrected, kept for context |

Both open questions have been answered and are recorded as OQ-001 and OQ-002 in
the decision log. Nothing is blocking.

---

## Guardrails

These are settled. Changing one needs a new decision recorded in the decision
log, not a code change.

- **The overlay is excluded from screen capture.** `setContentProtection(true)`,
  applied before the window is shown and never disabled. On Windows 10 builds
  before 19041 it degrades to a black rectangle in the capture, and the app warns
  about that once per session (NFR-012). This keeps the overlay
  from covering a presentation the candidate is sharing. It is a
  presentation-integrity control, not a way to hide the tool. (ADR-001)
- **A consent reminder is rendered before every session.** Dismissible,
  non-blocking, and impossible to turn off. What the app guarantees is that the
  reminder was rendered before the first suggestion, enforced by buffering
  suggestions until the overlay reports ready (ADR-016). It cannot guarantee the
  user read it, and it does not verify that the interviewer was told. Making the
  interviewer aware of the tool is the user's responsibility. The app supports
  that responsibility, it does not discharge it. (ADR-002)
- **Audio is never written to disk by this app.** Buffers live in memory and are
  released once transcribed. Proven by a filesystem write monitor, not only by a
  lint rule (ADR-019). Only text transcripts persist, and the user deletes them
  whenever they choose. Transcripts are plaintext JSON kept until deleted, with
  no encryption at rest and no retention window in v1. That is a deliberate
  choice, and the app says so in the Dashboard and in the consent copy rather
  than leaving it implicit. (FR-043, FR-110, ADR-003, OQ-001)

---

## Stack

Electron, TypeScript, React, Tailwind CSS, Framer Motion, Magic UI. Local
embeddings with `@xenova/transformers`. Packaged for Windows 10 and 11 x64 with
electron-builder.

Speech to text and suggestions both come from a **provider registry**, so the
user picks a provider and a specific model, and adding a provider later costs one
registry entry plus one adapter (ADR-022).

| Capability | Ships with |
|---|---|
| Speech to text | Deepgram `nova-3` (default) and `nova-2`, OpenAI `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`, ElevenLabs `scribe-v2-realtime`, plus OpenAI `whisper-1` as a clearly labeled non-streaming option |
| Suggestions | Anthropic `claude-haiku-4-5-20251001` (default), OpenAI `gpt-4o-mini` |

---

## Building the installer

One command, from a clean checkout, on Windows:

```bash
npm ci && npm run package
```

It writes `release/Interview CoPilot-<version>-x64.exe`, an x64 NSIS installer,
and `release/win-unpacked/` beside it. That is the whole of `NFR-013`: the build
is reproducible from a clean checkout with one documented command.

v1 ships **unsigned**. Windows SmartScreen warns on first run, which is expected
rather than a defect.

Two checks run against the output, in CI and available locally:

```bash
npm run check:packaged   # the installer exists and the unpacked modules are real files
npm run smoke:packaged   # the packaged app launches and paints a Dashboard (Windows only)
```

They exist because `onnxruntime-node` ships a native addon and `chokidar` 5 is
ESM-only, and neither can be loaded from inside an asar archive. A wrong
`asarUnpack` glob in `electron-builder.yml` still builds a green installer; the
app only breaks when it is run.

Cutting a release needs more than a green build. See
[`docs/07-release-checklist.md`](docs/07-release-checklist.md): the manual
checklist is recorded under `releases/<tag>.md`, and `npm run check:release`
refuses a release whose record is missing, incomplete or failing.

---

## Keeping the documents honest

```bash
python scripts/traceability.py
```

Regenerates `docs/05-traceability.md` and exits non-zero if any requirement has
no task, any requirement has no authored verification row, any requirement claims
a test no task builds, any task cites an undefined test, or any test verifies
nothing. This runs in CI. Documents that drift apart fail the build.

Requirement-to-test coverage is read from the hand-authored
`docs/06-verification-map.md`, never inferred from task membership. An earlier
version derived it by Cartesian product, crediting every test of a task to every
requirement that task traced, which let a requirement report full coverage with
no test that would fail if it broke. List a test on a requirement only if it
would fail when that requirement is broken.
