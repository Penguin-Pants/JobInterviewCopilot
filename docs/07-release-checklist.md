# Release procedure

How a tag becomes an installer. TASK-051, tracing `NFR-011`, `NFR-013` and
`NFR-015`.

The rule this document exists to enforce: **the manual checklist in
`04-test-strategy.md` section 6 is executed and recorded before a tag is cut,
and any single failure blocks the release.** `MW-12` is the one exception, and
section 3 says why.

---

## 1. Building the installer

One command, from a clean checkout, on Windows:

```
npm ci && npm run package
```

It writes `release/Interview CoPilot-<version>-x64.exe`, an x64 NSIS installer,
and `release/win-unpacked/`, the same app before packaging. That is the whole of
`NFR-013`'s "reproducible from a clean checkout with one documented command".

v1 ships **unsigned** (`NFR-013`, `ASM-013`). Windows SmartScreen will warn on
first run. That is expected and is not a defect to chase.

Two checks run against the output, in CI and available locally:

| Command | What it proves |
|---|---|
| `npm run check:packaged` | The installer exists, carries the version and `x64`, and the modules that cannot live inside an asar are real files on disk |
| `npm run smoke:packaged` | The packaged app launches, paints a Dashboard, completes its knowledge-base startup and logs no failure doing so (Windows only; it skips elsewhere rather than passing vacuously) |

Why both exist: `onnxruntime-node` ships a native addon, which `process.dlopen`
cannot open from inside an asar archive, and `chokidar` 5 is ESM-only, reached
through `import()`, which Electron's asar shim does not cover.
`electron-builder.yml` unpacks both. A wrong glob there still builds a green
installer; the app only breaks when it is run.

The two checks answer different questions. `check:packaged` proves the files are
on disk where the loader will look. `smoke:packaged` runs the app and reads its
own report of whether startup worked.

Waiting on the Dashboard alone would prove neither: `startKnowledgeBase` marks
profiles ready **before** awaiting `rag.start()` and catches what it throws, so
the Dashboard renders whether or not the watcher ever loaded. So the smoke test
waits for the model state, which is pushed on the last line of that function,
and then reads `main.log` for the failure `rag.start()` would have logged. A
failed `chokidar` import surfaces there and nowhere else.

What CI cannot reach is the native addon's own `dlopen`, which happens only when
something embeds. Loading it from outside the app does not answer the question
either: `app.evaluate` runs a serialized function with no `require` and no
dynamic-import callback, so it fails on the harness rather than on the app, and
a plain `node -e "require(...)"` would test Node's ABI rather than Electron's.
`MW-15` covers it, by importing and embedding a document on a clean install.

---

## 2. Recording the checklist

Each release carries a record at `releases/<tag>.md`.

1. Copy `releases/TEMPLATE.md` to `releases/<tag>.md`.
2. Run every check in `04-test-strategy.md` section 6 on real Windows hardware:
   one Windows 10 machine (build 19041 or later) and one Windows 11 machine.
3. Record `PASS` or `FAIL` for every row, with evidence on every row.
4. Open a pull request with the record. CI checks it (`npm run check:release`),
   so a bad record fails there rather than after the tag exists.
5. Tag once the record is merged and passing.

`npm run check:release` blocks on any of:

- a missing record, or a record for a different tag,
- a missing `Tag`, `Commit`, `Tester`, `Date`, `Windows 10 machine` or
  `Windows 11 machine` field,
- a `Commit` that is not a full 40-character sha, or that is not the commit
  being released,
- a Windows 10 machine naming no build, or a build below 19041, which is where
  capture exclusion degrades (`NFR-012`) and therefore where `MW-01` stops
  testing what it says,
- any checklist id with no row, or with a row recorded twice,
- any `FAIL` other than `MW-12`,
- `NOTED` on anything other than `MW-12`,
- a row with a result and no evidence,
- `MW-06` or `MW-11` passing without `p50` and `p95` **with units**, or with a
  number **over its budget**.

That last one is worth stating plainly: the verdict is the tester's, the number
is the measurement, and they can disagree. A record reading `PASS` beside
`p50 99 s` is a slip, and the gate reads the number. `NFR-001` puts `MW-06` at
p50 under 2.5 s and p95 under 4.0 s; `NFR-017` puts `MW-11` at 7.0 s and 10.0 s.

Units are required because `p50 1900` is a comfortable pass in milliseconds and
a catastrophe in seconds, and guessing which would be worse than asking.

The full checklist is required of the release being prepared, named by tag. The
sweep that runs on every pull request checks each merged record against what it
claims rather than against today's list, so adding a check later does not
retroactively invalidate every release before it.

The required ids are read out of `04-test-strategy.md` section 6 rather than
listed in the checker, the same way `scripts/traceability.py` derives its
tables. A checklist that grows a row does not leave the gate behind still
requiring the old set.

---

## 3. What blocks, and what does not

**Everything blocks except `MW-12`.** `MW-12` plays music and fires a desktop
notification during a session and confirms both are transcribed onto the
interviewer stream. That is what `ADR-021` predicts and what the session-prep
note warns about: WASAPI loopback takes all system audio, and interviewer-only
isolation is not a v1 goal. `MW-12` therefore records information, not a defect,
and `NOTED` is its expected result.

**`MW-06` and `MW-11` must carry numbers.** They are the latency budgets
(`NFR-001` p50 under 2.5 s and p95 under 4.0 s; `NFR-017` p50 under 7.0 s and
p95 under 10.0 s). A bare `PASS` on a number nobody wrote down is how a budget
quietly stops being measured, so the gate rejects one.

---

## 4. What CI cannot do

Stated plainly, because a release procedure that overclaims is worse than one
that admits its edges:

| Not covered | Why | Covered by |
|---|---|---|
| Installing from the NSIS package onto a clean Windows 11 machine | No clean-VM stage in v1 (`04-test-strategy.md` section 7). CI builds and launches the unpacked app; it never runs the installer | `MW-15`, which exists for exactly this and is required of every record |
| Real loopback and microphone capture | No virtual audio device on a runner (`ADR-004`) | `MW-02`, `MW-03`, `MW-04` |
| Real screen-capture exclusion | Cannot be asserted from inside the process | `MW-01` |
| Real provider latency, accuracy and cost | Non-deterministic and paid. `TC-133` measures the app's own share of the budget; the end-to-end numbers need a real network | `MW-05`, `MW-06`, `MW-11`, `MW-13` |
| Average CPU across all processes on a 4-core machine | `TC-131` measures the main process inside the test runner, which inflates rather than flatters it | `MW-14` |
| Multi-DPI rendering | No multi-monitor runner | `MW-07` |

None of these is a gap the pipeline can close. They are the reason section 6
exists and the reason a release is gated on a human having run it.

- [ ] Verify Provider Setup reports account, fallback, missing-key, stale, and partial provider results without exposing credentials.
- [ ] Verify `stt-catalog.json` contains descriptors and timestamps only and survives an offline forced refresh.
