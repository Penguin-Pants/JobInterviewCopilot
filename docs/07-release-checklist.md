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
| `npm run smoke:packaged` | The packaged app launches and paints a Dashboard (Windows only; it skips elsewhere rather than passing vacuously) |

Why the first one exists: `onnxruntime-node` ships a native addon, which
`process.dlopen` cannot open from inside an asar archive, and `chokidar` 5 is
ESM-only, reached through `import()`, which Electron's asar shim does not cover.
`electron-builder.yml` unpacks both. A wrong glob there still builds a green
installer; the app only breaks when it is run, on a machine nobody in CI is
watching.

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
- a missing `Tag`, `Commit`, `Tester` or `Date` field,
- any checklist id with no row, or with a row recorded twice,
- any `FAIL` other than `MW-12`,
- `NOTED` on anything other than `MW-12`,
- a row with a result and no evidence,
- `MW-06` or `MW-11` passing without measured `p50` and `p95` numbers.

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
| Installing from the NSIS package onto a clean Windows 11 machine | No clean-VM stage in v1 (`04-test-strategy.md` section 7). CI builds and launches the unpacked app; it never runs the installer | `MW-01` to `MW-14`, on real hardware |
| Real loopback and microphone capture | No virtual audio device on a runner (`ADR-004`) | `MW-02`, `MW-03`, `MW-04` |
| Real screen-capture exclusion | Cannot be asserted from inside the process | `MW-01` |
| Real provider latency, accuracy and cost | Non-deterministic and paid. `TC-133` measures the app's own share of the budget; the end-to-end numbers need a real network | `MW-05`, `MW-06`, `MW-11`, `MW-13` |
| Average CPU across all processes on a 4-core machine | `TC-131` measures the main process inside the test runner, which inflates rather than flatters it | `MW-14` |
| Multi-DPI rendering | No multi-monitor runner | `MW-07` |

None of these is a gap the pipeline can close. They are the reason section 6
exists and the reason a release is gated on a human having run it.
