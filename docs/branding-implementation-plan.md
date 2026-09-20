# Interview Copilot Branding Implementation Plan

## Goal

Implement the approved Interview Copilot visual identity in the existing Electron application without changing product behavior or weakening existing accessibility, overlay or configuration guarantees.

## Current-state observations

The repository already has:
- Electron + React + TypeScript
- Tailwind CSS in the overlay
- Framer Motion
- a simple CSS-token dashboard
- user-selectable theme mode and accent
- acrylic/opacity overlay settings
- tested overlay contrast calculations
- explicit reduced-motion and idle-motion behavior
- electron-builder NSIS packaging

The implementation should extend these foundations rather than replace them.

---

## Phase 0: Audit and safeguard

Before code changes:

1. Read:
   - `docs/00-decision-log.md`
   - `docs/01-requirements.md`
   - `docs/02-architecture.md`
   - `docs/03-tasks.md`
   - `docs/04-test-strategy.md`
   - `docs/design.md`
2. Identify all current:
   - product-name strings
   - theme variables
   - hard-coded colors
   - radii
   - typography rules
   - icon/package configuration
   - Magic UI usage, if any
3. Map the visual changes to existing requirements/tests.
4. Document any conflict before implementation.
5. Do not change functional behavior as part of a style cleanup.

Deliverable:
- short audit note or implementation checklist in the PR description

---

## Phase 1: Install brand assets and naming

1. Copy `/branding` assets into an appropriate application asset location.
2. Use `app-icon.ico` for Windows packaging.
3. Change `electron-builder.yml` user-facing `productName` to `Interview Copilot`.
4. Update user-facing title strings from `Interview CoPilot` to `Interview Copilot`.
5. Do not rename internal package identifiers unless required.

Acceptance:
- packaged installer displays the new name
- executable/taskbar/Start Menu use the approved icon
- existing package verification scripts still pass

---

## Phase 2: Introduce shared design tokens

Create one shared token source or clearly synchronized light/dark CSS token layer.

Tokens should cover:
- fixed brand colors
- UI background/surface/text/muted/border
- radii
- spacing
- transition durations
- typography

Keep separate:
- fixed brand blue
- configurable user accent

Do not hard-code brand blue as `--accent`.

Acceptance:
- user accent still changes interactive accent states
- logo remains fixed brand blue
- light/dark/system modes still work

---

## Phase 3: Dashboard visual refresh

Apply the new system without changing information architecture.

Focus:
- header identity
- sidebar/tab states
- card surfaces
- buttons
- inputs/selects/textarea
- badges/status
- section hierarchy
- spacing
- empty/loading/error states

Keep:
- native controls where already intentional
- ARIA tab behavior
- current session state visibility
- current data flow

Magic UI:
- introduce only components that add clear value
- prefer copied-in components compatible with current React/Tailwind/Framer stack
- avoid broad dependency churn

Acceptance:
- all dashboard tests pass
- keyboard navigation remains intact
- contrast remains accessible
- no tab or form behavior changes

---

## Phase 4: Onboarding and non-live experience

Where suitable, introduce:
- approved brand lockup
- Primary & Outline icon
- one-time BlurFade entrance
- optional restrained MagicCard treatment
- optional restrained BorderBeam for explicit setup completion/progress only

Do not add continuous ambient effects.

Acceptance:
- `prefers-reduced-motion` has a no-motion equivalent
- effects do not block or delay actions
- no effect is required to understand status

---

## Phase 5: Overlay visual alignment

Treat this as a separate, high-risk phase.

Allowed changes:
- radius refinement
- spacing refinement
- typography polish that preserves user font-size setting
- restrained idle/consent brand treatment
- border token cleanup

Must preserve:
- contrast floor logic in `theme.ts`
- user-configurable accent
- translucency behavior
- screen-capture protection
- single-card behavior
- reduced motion
- zero idle animation
- all existing overlay state logic

Do not add Magic UI animation to active suggestion cards.

Acceptance:
- overlay unit/integration tests pass
- contrast tests pass
- idle animation remains zero
- suggestion readability is not reduced

---

## Phase 6: Asset and platform verification

Verify assets at:
- 16 px
- 20 px
- 24 px
- 32 px
- 40 px
- 48 px
- 64 px
- 128 px
- 256 px

Verify Windows display scaling:
- 100%
- 125%
- 150%

Verify contexts:
- installer
- executable
- taskbar
- Start Menu
- Dashboard header
- optional system tray, if used
- GitHub repository avatar separately

---

## Phase 7: Visual regression and final QA

Capture screenshots for:
- Dashboard dark
- Dashboard light
- Overlay dark
- Overlay light
- Overlay interactive
- Overlay click-through appearance
- empty/loading/error states
- onboarding/setup states

Review against `docs/design.md`.

Run:
- typecheck
- lint
- unit tests
- integration tests
- build
- package checks
- packaged smoke test where available

Do not accept visual completion with failing functional tests.

---

## Explicit non-goals

This branding project does not:
- redesign the information architecture
- change session logic
- change providers or models
- change overlay triggering
- replace the user's accent setting
- add heavy animation
- rebuild the app using a different component framework
- convert the live overlay into a marketing-style Magic UI surface

---

## PR strategy

Prefer small, reviewable commits:

1. `brand: add approved assets and product naming`
2. `style: add shared design tokens`
3. `style: refresh dashboard`
4. `style: add restrained onboarding treatments`
5. `style: align overlay with brand system`
6. `test: add/update visual and packaging checks`

Do not combine unrelated refactors into these commits.
