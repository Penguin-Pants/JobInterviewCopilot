# Release record — vX.Y.Z

Copy this file to `releases/v<version>.md`, run every check on real Windows
hardware, and record the result. `scripts/check-release-record.mjs` reads it and
refuses to release on any blocker. See `docs/07-release-checklist.md`.

**Tag** vX.Y.Z
**Commit** <the full 40-character sha the installer was built from>
**Tester** <who ran the checklist>
**Date** YYYY-MM-DD
**Windows 10 machine** <build number, 19041 or later>
**Windows 11 machine** <build number>

`PASS` or `FAIL` for every row. `NOTED` is accepted for MW-12 alone. Evidence is
required on every row: a result with nothing behind it is not a record. MW-06 and
MW-11 must carry measured `p50` and `p95` numbers **with units**, and the gate
compares them against their budgets rather than trusting the verdict.

| ID | Result | Evidence |
|---|---|---|
| TC-001 | | clean checkout, `npm ci && npm run package` exit code and installer name |
| MW-01 | | Share the screen in Zoom, Teams and Google Meet with the overlay visible |
| MW-02 | | Loopback capture with real system audio |
| MW-03 | | Microphone capture with a real headset and with a laptop array mic |
| MW-04 | | Both streams at once with the interviewer and candidate speaking over each other |
| MW-05 | | Full interview rehearsal, 20 minutes |
| MW-06 | | p50 _ s, p95 _ s over 20 turns (budget p50 2.5 s, p95 4.0 s) |
| MW-07 | | Drag the overlay across two monitors with different DPI, then relaunch |
| MW-08 | | Both hotkeys while another application has focus |
| MW-09 | | Unplug the network mid-session |
| MW-10 | | Kill the process mid-session, relaunch |
| MW-11 | | p50 _ s, p95 _ s over 20 turns (budget p50 7.0 s, p95 10.0 s) |
| MW-12 | | NOTED is the expected outcome: it confirms ADR-021 and cannot fail the release |
| MW-13 | | Rehearsal on each streaming STT provider, 10 turns each: Deepgram `nova-3`, OpenAI `gpt-4o |
| MW-14 | | Watch Task Manager across a 20-minute rehearsal |
| MW-15 | | the clean machine used, and that the installed app launched and embedded a document |
