# Interview Copilot Design System

Version 1.0  
Status: Approved implementation baseline  
Primary brand concept: **Primary & Outline / Co-pilot Seat**

## 1. Brand foundation

### Product idea

Interview Copilot is a real-time recall aid for job candidates. It listens to the interviewer's turn, filters non-actionable speech, retrieves relevant information from the candidate's own resume, notes and company research, then shows short cue-form reminders.

The product must not look like an AI that answers for the candidate.

### Core brand statement

> **You lead. Copilot supports.**

Supporting phrase:

> **Your knowledge, when you need it.**

### Brand attributes

- Human-first
- Supportive
- Discreet
- Precise
- Calm
- Confident

## 2. Naming

Use **Interview Copilot** everywhere.

Do not use:
- Interview CoPilot
- JobInterviewCopilot in user-facing UI
- Job Interview Copilot unless needed as descriptive metadata

Repository and package identifiers may remain technical where required, but user-facing product copy should use **Interview Copilot**.

## 3. Logo concept

The mark contains two abstract seated/person forms:

- **Candidate:** solid foreground figure on the left
- **Copilot:** outlined accent figure on the right
- Equal head diameter signals partnership
- Solid-vs-outline treatment establishes hierarchy
- The candidate is visually primary
- The copilot is adjacent and supportive, never enclosing or dominating the candidate

The mark must not be modified into a robot, headset, microphone, sparkle, brain or chat bubble.

## 4. Logo geometry

Master coordinate system: 100 x 100.

### Candidate
- Head center: x=29, y=29
- Head radius: 8.5
- Body: x=16, y=42, width=27, height=30
- Body corner radius: 9
- Fill: foreground color

### Copilot
- Head center: x=68, y=29
- Head radius: 8.5
- Body: x=53, y=42, width=28, height=30
- Body corner radius: 9
- Stroke: 7
- Fill: none
- Color: brand primary

### Container
- Standard master: 100 x 100
- Container: x=2, y=2, width=96, height=96
- Corner radius: 22
- Never stretch the mark non-uniformly

### Small-size optical correction

At 16 and 24 px:
- Increase stroke to approximately 7.5 master units
- Slightly reduce spacing between the two figures
- Keep head diameters equal
- Prefer crisp silhouette over geometric purity
- Use the supplied `icon-16.svg` and `icon-24.svg`, not a generic downscale

At 32 px and larger use the standard geometry.

## 5. Clear space

Define **X** as the candidate head diameter.

Minimum clear space outside the standalone mark:
- 0.75X on all sides

Icon + wordmark:
- Minimum horizontal gap between icon and wordmark: 0.75X

Do not crowd the logo with status indicators or notification badges unless the operating system adds them.

## 6. Color system

### Fixed brand colors

| Token | Value | Use |
|---|---|---|
| `brand.primary` | `#3B82F6` | Logo outline, brand emphasis |
| `brand.accent` | `#60A5FA` | Secondary brand highlight |
| `brand.background.dark` | `#0B0F17` | Branded dark backgrounds |
| `brand.surface.dark` | `#1F2937` | Dark cards and surfaces |
| `brand.text.dark` | `#F4F6FA` | Primary text on dark |
| `brand.muted.dark` | `#A1A1AA` | Secondary text on dark |
| `brand.border.dark` | `#334155` | Restrained borders |
| `brand.background.light` | `#F7F8FA` | Branded light backgrounds |
| `brand.surface.light` | `#FFFFFF` | Light cards |
| `brand.text.light` | `#111827` | Primary text on light |
| `brand.muted.light` | `#5F6673` | Secondary text on light |
| `brand.border.light` | `#D7DCE3` | Light borders |

### Brand color vs user accent

**Important:** the fixed brand blue is not the same thing as the user's configurable application accent.

Current product behavior allows the user to set `theme.accent`. Preserve that behavior.

Use fixed brand colors for:
- logo
- onboarding identity
- product naming
- installer/app assets
- optional non-configurable brand marks

Use the user's configured accent for:
- primary actions
- focus rings
- interactive overlay border
- user-customizable appearance states

Do not replace the user's accent setting with the brand blue.

## 7. Typography

Primary in-product typeface:

```css
font-family: system-ui, "Segoe UI Variable", "Segoe UI", sans-serif;
```

Preferred Windows typeface: **Segoe UI Variable**.

Do not add a packaged web font unless a later product decision requires it.

### Type hierarchy

- Page title: 24 px / 600
- Section title: 18 px / 600
- Subsection: 15-16 px / 600
- Body: 14 px / 400
- Supporting text: 13 px / 400
- Small metadata: 12 px / 400
- Live overlay text remains governed by the existing user-configurable overlay font-size system

## 8. Spacing

Use a 4 px base grid.

Recommended scale:
- 4
- 8
- 12
- 16
- 20
- 24
- 32
- 40
- 48

Prefer 16-24 px internal card padding in dashboard surfaces.

Do not reduce spacing in the live overlay solely for brand consistency. Readability and glanceability take priority.

## 9. Radius system

- Small controls: 6 px
- Standard controls: 8 px
- Cards/panels: 12 px
- Feature/onboarding cards: 16 px
- Brand icon container: proportion equivalent to 22/100 of icon width

Avoid excessive pill shapes.

## 10. Borders and elevation

Dark mode:
- Use restrained 1 px borders based on `brand.border.dark`
- Elevation should come primarily from contrast between surfaces
- Shadows should be soft and limited

Light mode:
- 1 px border based on `brand.border.light`
- Very light shadow permitted for raised panels

No permanent glows.

## 11. Buttons

### Primary
Use the **user-configured accent**, not fixed brand blue, unless the button exists in non-configurable onboarding/marketing brand material.

- Height: 36-40 px
- Radius: 8 px
- Font weight: 600
- Maintain existing foreground contrast calculation

### Secondary
- Surface or transparent background
- 1 px border
- High-contrast text
- No glow

### Destructive
Continue to use dedicated alert/destructive tokens.

## 12. Cards

Dashboard cards:
- 12 px radius
- 1 px border
- Clear heading
- One main purpose per card
- Avoid decorative effects on every card

Live overlay card:
- Preserve existing tested contrast floor
- Preserve translucency calculations
- Preserve single-card behavior
- Preserve user opacity and acrylic/opacity settings
- Do not introduce decorative background gradients, blur hacks or permanent animated effects

## 13. Dashboard

The dashboard should feel:
- calm
- structured
- compact
- native to a Windows desktop application
- visually richer than the current prototype without becoming a marketing page

Recommended shell:
- Brand lockup in header at restrained size
- Existing left navigation pattern remains valid
- Use brand icon for identity, not as repeated decoration
- Active tab continues to use accessible state styling
- Session state must remain visible regardless of tab

## 14. Overlay

The overlay is a protected functional surface.

Branding must be minimal.

Allowed:
- small Interview Copilot mark in idle/consent state if it does not reduce readability
- refined border/radius tokens
- fixed brand mark only outside user-accent interactions

Not allowed:
- Border Beam around live suggestion cards
- continuous glow
- looping brand animation
- animated logo while idle
- motion that competes with cue text
- replacement of existing contrast calculations

Existing requirements such as NFR-007, FR-093 and reduced-motion behavior take priority.

## 15. Magic UI usage

Magic UI is an implementation resource, not a visual mandate.

Use Magic UI patterns/components selectively where they improve:
- onboarding
- setup confirmation
- empty states
- feature introduction
- non-critical loading/progress feedback

Good candidates:
- `MagicCard` for selected onboarding/feature surfaces
- `BlurFade` for first-load entrance in non-live views
- restrained `BorderBeam` for one-time setup/progress state
- restrained animated indicators for explicit processing

Do not use animated Magic UI effects in the live overlay unless they are:
1. user-triggered or state-triggered
2. short-lived
3. compatible with `prefers-reduced-motion`
4. proven not to violate NFR-007
5. not visually competitive with interview cues

The current stack uses React, Tailwind CSS and Framer Motion. Prefer copy-in components that fit this stack. Do not add a large design-system dependency only for branding.

## 16. Motion

Default motion rules:
- No continuous ambient motion in core application chrome
- 120-220 ms transitions for hover/selection
- 180-300 ms entrance transitions in onboarding
- Ease-out for entrances
- Respect `prefers-reduced-motion`
- Live overlay idle state: no animation

Logo animation, if used outside live mode:
- Candidate stays fixed
- Copilot outline can fade/trace in once
- Never pulse indefinitely

## 17. Accessibility

Preserve or improve:
- 4.5:1 contrast for normal text
- visible keyboard focus
- native controls where practical
- ARIA tab behavior
- reduced-motion support
- Windows scaling
- screen-reader labels

Do not use brand fidelity as a reason to weaken accessibility behavior.

## 18. Light and dark mode

Both are supported.

Dark should remain the visually primary branded presentation, but no product feature may assume dark mode.

The logo assets include light and dark variants.

## 19. Asset inventory

Production assets in `/branding`:

- `logo-primary.svg`
- `logo-monochrome.svg`
- `logo-dark.svg`
- `logo-light.svg`
- `logo-transparent.svg`
- `wordmark-horizontal-dark.svg`
- `wordmark-horizontal-light.svg`
- `icon-16.svg`
- `icon-24.svg`
- `icon-32.svg`
- `favicon.svg`
- `app-icon.ico`
- PNG app icons from 32 to 1024 px
- `github-avatar-512.png`

## 20. Windows packaging

Update `electron-builder.yml`:
- `productName` -> `Interview Copilot`
- configure Windows icon to use the supplied `app-icon.ico`
- preserve current NSIS and packaging behavior

Verify:
- executable icon
- installer icon
- taskbar icon
- Start Menu icon
- installed application name

## 21. User-facing product name cleanup

Audit all user-visible instances of:
- `Interview CoPilot`
- `JobInterviewCopilot`
- variants

Change user-facing copy to:
- `Interview Copilot`

Do not blindly rename internal identifiers, package names, test IDs or app IDs without a technical reason.

## 22. Implementation principle

Brand implementation must be **incremental**.

Do not rewrite functional components solely to apply styling.

Priority order:
1. preserve behavior
2. preserve accessibility and tested requirements
3. establish tokens
4. add assets
5. refactor styling only where necessary
6. introduce selected Magic UI treatments
7. verify visually and functionally

## 23. Definition of done

Brand implementation is complete only when:

- Product name is consistent in user-facing UI
- Windows package uses approved icon
- Dashboard uses design tokens
- Light and dark themes remain functional
- User accent remains configurable
- Overlay contrast tests still pass
- Overlay reduced-motion and idle-motion guarantees still pass
- All existing functional tests pass
- Logo renders cleanly at 16, 24 and 32 px
- 100%, 125% and 150% Windows scaling have been checked
- No permanent animation has been added to the live overlay
- No generic AI visual clichés have been introduced
