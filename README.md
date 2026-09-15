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
| [`docs/00-decision-log.md`](docs/00-decision-log.md) | Which way each contested question was settled, and what is still an assumption |
| [`docs/01-requirements.md`](docs/01-requirements.md) | What the product must do, as 89 verifiable requirements |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Components, data model, interfaces, IPC contract, dependencies |
| [`docs/03-tasks.md`](docs/03-tasks.md) | 26 implementation tasks with binary acceptance criteria and the global Definition of Done |
| [`docs/04-test-strategy.md`](docs/04-test-strategy.md) | 100 automated test cases, 10 manual Windows checks, the CI pipeline |
| [`docs/05-traceability.md`](docs/05-traceability.md) | Generated matrix. Every requirement maps to a task and a test |
| [`MASTER_BUILD_PROMPT.md`](MASTER_BUILD_PROMPT.md) | The original product brief, kept for context |

---

## Guardrails

These are settled. Changing one needs a new decision recorded in the decision
log, not a code change.

- **The overlay is excluded from screen capture.** `setContentProtection(true)`,
  applied before the window is shown and never disabled. This keeps the overlay
  from covering a presentation the candidate is sharing. It is a
  presentation-integrity control, not a way to hide the tool. (ADR-001)
- **A consent reminder is shown before every session.** Dismissible,
  non-blocking, and impossible to turn off. Making the interviewer aware of the
  tool is the user's responsibility. The app supports that responsibility.
  (ADR-002)
- **Audio is never written to disk.** Buffers live in memory and are released
  once transcribed. Only text transcripts persist, and the user deletes them
  whenever they choose. (FR-043, ADR-003)

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
