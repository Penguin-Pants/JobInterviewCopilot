# Vendored components

Code copied into this repository rather than installed from npm.

## Why this file exists

`npm run licenses` scans `package.json` dependencies. Code that is copied in,
Magic UI in particular, is structurally invisible to that scan, so `NFR-015`
could not actually enforce what it promises for the one dependency most likely
to be pasted in by hand.

`NFR-016` closes that hole: every vendored file must appear in the table below
with its source, version and license, and `scripts/check-licenses.mjs` fails the
build when one does not. This file is the input to that check, not documentation
about it.

## Rules

- Vendored code lives under `src/renderer/<window>/vendor/`.
- Every file gets a row naming its source URL, the version or commit copied, and
  its license.
- The license must be MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD,
  CC0-1.0, Unlicense, BlueOak-1.0.0, Python-2.0 or CC-BY-4.0.
- Record the upstream version so an upstream fix can be re-applied later.

## Components

| File | Source | Version or commit | License |
|---|---|---|---|
| _(none yet)_ | Magic UI card components arrive in TASK-043 | | |
