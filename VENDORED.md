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
| _(none)_ | | | |

## Why Magic UI is not here

`TASK-043` was expected to add the Magic UI card components to the table above.
It did not, and the empty table is the accurate record rather than an oversight.

Magic UI's source could not be obtained in the build environment:
`magicui.design`, `raw.githubusercontent.com`, `cdn.jsdelivr.net` and
`unpkg.com` are all refused by the network egress proxy, and the two Magic UI
packages on npm (`@magicuidesign/cli`, `@magicuidesign/mcp`) are thin clients
that fetch the component registry from `magicui.design` at run time and carry no
component source of their own.

A row here names a source URL, a version and a license for a file copied from
that source. Writing one for code that was not copied from there would be a
false statement in the one file `NFR-016` exists to make trustworthy, and
`scripts/check-licenses.mjs` reads this file as its input rather than as
documentation about itself. So the overlay's cards are first-party components
under `src/renderer/overlay/components/`, built on Tailwind and styled from the
`FR-029` theme tokens, which is the rest of what `FR-094` asks for.

`FR-094` is therefore partially met. The remainder is carried to `TASK-051`
with this reason. See ADR-040.
