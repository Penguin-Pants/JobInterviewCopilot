# Task: Implement the approved Interview Copilot brand system

You are working in the existing Interview Copilot repository.

The visual identity has already been decided. Do **not** redesign the brand and do not generate alternate concepts.

## Source of truth

Read these first, in this order:

1. `docs/00-decision-log.md`
2. `docs/01-requirements.md`
3. `docs/02-architecture.md`
4. `docs/03-tasks.md`
5. `docs/04-test-strategy.md`
6. `docs/design.md`
7. `docs/branding-implementation-plan.md`

The existing decision log and product requirements still win if any branding instruction conflicts with a settled product requirement.

The approved production assets are in `/branding`.

## Objective

Implement the approved **Interview Copilot** visual identity throughout the existing application while preserving all existing functionality, accessibility behavior, tests and product guardrails.

The approved visual concept is **Primary & Outline / Co-pilot Seat**:

- solid candidate figure on the left
- outlined blue copilot figure on the right
- candidate remains visually primary
- copilot communicates support, not replacement

User-facing product name is now:

**Interview Copilot**

## Critical constraints

### 1. Do not replace the configurable user accent

The application already allows the user to configure `theme.accent`.

Preserve this.

The fixed brand blue is for the logo and fixed brand identity. The user accent continues to drive interactive states such as primary controls, focus and the interactive overlay border.

Do not set `--accent` permanently to the brand blue.

### 2. Treat the overlay as protected functionality

Do not weaken or bypass:
- contrast calculations
- minimum surface alpha logic
- acrylic/opacity handling
- user opacity
- user font sizing
- screen-capture protection
- single-card behavior
- reduced-motion behavior
- NFR-007 zero idle animation
- current trigger/suggestion behavior

Do not add Magic UI animation around active suggestion cards.

### 3. Magic UI is selective

The project uses the Magic UI approach/library ecosystem.

Use relevant Magic UI components only where they add clear value, mainly:
- onboarding
- setup
- empty states
- one-time processing/progress feedback

Potential components:
- MagicCard
- BlurFade
- restrained BorderBeam

Before adding one:
- verify it works with the current React/Tailwind/Framer stack
- prefer copied-in/local components over broad dependency changes
- add reduced-motion behavior
- do not add ambient infinite animation in core UI

### 4. Avoid unnecessary refactors

Do not rewrite functional components because you prefer a different component architecture.

This is a branding implementation, not a product rewrite.

## Required workflow

### Step 1: Audit before changing code

Inspect the repository and produce a concise implementation checklist covering:

- every user-facing `Interview CoPilot` or other product-name occurrence
- current app/package icon configuration
- current theme variables
- hard-coded colors
- current radii and typography
- dashboard styling structure
- overlay styling structure
- any existing Magic UI components
- tests likely affected

Compare this with `docs/design.md`.

If you find a conflict with existing requirements, stop that specific change and document the conflict. Do not invent a resolution.

### Step 2: Implement in phases

Follow `docs/branding-implementation-plan.md`.

Implement one phase at a time.

After each phase:
- typecheck
- run the directly affected tests
- inspect the diff for unrelated changes

### Step 3: Packaging

Use the supplied `/branding/app-icon.ico`.

Update user-facing `productName` to:

`Interview Copilot`

Verify electron-builder packaging still works.

Do not rename `appId` without a specific technical reason.

### Step 4: Design tokens

Establish reusable design tokens based on `docs/design.md`.

Do not duplicate colors in many files.

Keep fixed brand tokens distinct from the user's runtime accent.

### Step 5: Dashboard

Refresh the dashboard styling while preserving:
- current tab structure
- native/accessible controls
- ARIA behavior
- active session status
- existing data/state management

Use restrained branded surfaces, spacing and typography.

### Step 6: Overlay

Apply only minimal visual alignment.

Do not copy dashboard effects into the overlay.

Run all relevant contrast, theme, reduced-motion and overlay tests after this phase.

### Step 7: Verification

Run the complete available verification suite:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Where the environment supports Windows packaging:

```bash
npm run package
npm run check:packaged
npm run smoke:packaged
```

Also verify or document manual checks for:
- 100% Windows scaling
- 125%
- 150%
- 16 px icon
- 24 px icon
- 32 px icon
- light theme
- dark theme
- system theme
- reduced motion
- user-defined accent
- overlay translucency

## Review pass

Before finishing, perform two passes over the complete diff.

### Pass 1: Functional and regression review

Look for:
- behavior changes hidden inside styling work
- broken tests
- broken accessibility
- loss of user accent configurability
- overlay contrast regressions
- packaging regressions
- new infinite animations
- unnecessary dependencies

Fix every issue found.

### Pass 2: Design-system review

Compare the implementation to `docs/design.md`.

Look for:
- inconsistent product naming
- duplicated one-off colors
- inconsistent radii
- excessive animation
- generic AI visual clichés
- brand blue incorrectly replacing configurable accent
- logo misuse
- inconsistent light/dark behavior

Fix every issue found.

Repeat review until no material issues remain.

## Final output

Provide:

1. Summary of implemented changes
2. Files added/changed
3. Tests and verification run
4. Any manual Windows checks still required
5. Any design spec item intentionally not implemented and why

Do not claim visual verification you did not perform.
