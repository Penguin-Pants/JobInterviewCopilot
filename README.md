# Interview CoPilot

A native Windows desktop app that gives a job candidate real-time, glanceable
cues during a live video interview, drawn from their own resume, company
research and notes. The purpose is accessibility support, for example ADHD or
memory recall under stress. It is not a scripting tool.

**Status: specification complete, implementation not started.**

---

## Documents

Read them in this order. The decision log wins over every other document.

| Document | What it answers |
|---|---|
| [`docs/00-decision-log.md`](docs/00-decision-log.md) | Which way each contested question was settled, what is still an assumption, and what is still open |
| [`docs/01-requirements.md`](docs/01-requirements.md) | What the product must do, as 104 verifiable requirements |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Components, data model, interfaces, IPC contract, dependencies |
| [`docs/03-tasks.md`](docs/03-tasks.md) | 26 implementation tasks with binary acceptance criteria and the global Definition of Done |
| [`docs/04-test-strategy.md`](docs/04-test-strategy.md) | 117 automated test cases, 12 manual Windows checks, the CI pipeline |
| [`docs/05-traceability.md`](docs/05-traceability.md) | Generated matrix. Every requirement maps to a task and a test |
| [`MASTER_BUILD_PROMPT.md`](MASTER_BUILD_PROMPT.md) | The original product brief, corrected, kept for context |

Two questions are open for the product owner and are recorded as OQ-001 and
OQ-002 in the decision log. Neither blocks the build. Both change the product if
answered differently.

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
  whenever they choose. Today those transcripts are plaintext JSON and are kept
  forever by default. See OQ-001. (FR-043, ADR-003)

---

## Stack

Electron, TypeScript, React, Tailwind CSS, Framer Motion, Magic UI. Deepgram or
OpenAI Whisper for speech to text. Anthropic or OpenAI for suggestions. Local
embeddings with `@xenova/transformers`. Packaged for Windows 10 and 11 x64 with
electron-builder.

---

## Keeping the documents honest

```bash
python scripts/traceability.py
```

Regenerates `docs/05-traceability.md` and exits non-zero if any requirement has
no task, any requirement has no test, any task cites an undefined test, or any
test is orphaned. This runs in CI. Documents that drift apart fail the build.
