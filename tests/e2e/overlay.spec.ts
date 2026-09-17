import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, overlayPage, pushToDashboard, pushToOverlay } from './launch.js';
import { SETTINGS_LIMITS } from '../../src/shared/defaults.js';
import { FONT_STEP_PX } from '../../src/renderer/overlay/components/FontSizeControl.js';

/**
 * TASK-043 Overlay UI: TC-006, TC-110, TC-111, TC-112, TC-113, TC-115, TC-116,
 * TC-117, TC-138, and `FR-089`'s Dashboard half of TC-142.
 *
 * Skipped off Windows, like the rest of the Electron suite. These drive the
 * real overlay window, the real preload bridge and the real main-process
 * handlers, and the coverage policy makes E2E the only verification
 * `src/renderer/**` gets (ADR-004).
 *
 * The pure halves are asserted in the unit suite, where they can be driven
 * exhaustively rather than sampled: `tests/unit/overlay-cards.test.ts` for the
 * stack rules and `tests/unit/overlay-theme.test.ts` for `TC-114`'s contrast
 * over every theme and opacity combination.
 */
test.skip(process.platform !== 'win32', 'Electron E2E runs on the Windows target only');

let app: ElectronApplication;
let dashboard: Page;
let overlay: Page;
let userDataDir: string;

test.beforeEach(async () => {
  ({ app, dashboard, userDataDir } = await launchApp());
  overlay = await overlayPage(app);
});

test.afterEach(async () => {
  await app.close();
});

/** One generation, as the three channels really deliver it. */
async function generate(id: string, question: string, lines: string[]): Promise<void> {
  await pushToOverlay(app, 'suggestion:begin', {
    generationId: `gen-${id}`,
    cardId: `card-${id}`,
    question,
  });
  for (const [index, line] of lines.entries()) {
    await pushToOverlay(app, 'suggestion:line', {
      generationId: `gen-${id}`,
      cardId: `card-${id}`,
      line,
      index,
    });
  }
  await pushToOverlay(app, 'suggestion:end', { generationId: `gen-${id}`, status: 'complete' });
}

/**
 * Watch a bullet's opacity and transform from **before** it exists.
 *
 * A settled assertion cannot tell a fade from no fade: a bullet that was never
 * animated also ends at opacity 1, so `toHaveText`/`toBe('1')` pass either way.
 * Sampling after the push is racy in the other direction, because the element
 * may not be there yet and a 250 ms reveal is easy to miss.
 *
 * So the sampler is installed first and runs every frame, recording the lowest
 * opacity and whether any non-identity transform was ever applied. Whatever the
 * timing, the frames are observed rather than guessed at.
 */
async function watchFirstBullet(): Promise<void> {
  await overlay.evaluate(() => {
    const probe = window as unknown as {
      __reveal?: { minOpacity: number; sawTransform: boolean; raf?: number };
    };
    if (probe.__reveal?.raf !== undefined) cancelAnimationFrame(probe.__reveal.raf);
    const state = { minOpacity: 1, sawTransform: false, raf: 0 };
    probe.__reveal = state;
    const identity = new Set(['none', 'matrix(1, 0, 0, 1, 0, 0)']);
    const tick = (): void => {
      const el = document.querySelector('[data-testid="bullet"]');
      if (el) {
        const style = getComputedStyle(el);
        const opacity = Number.parseFloat(style.opacity);
        if (Number.isFinite(opacity)) state.minOpacity = Math.min(state.minOpacity, opacity);
        if (!identity.has(style.transform)) state.sawTransform = true;
      }
      state.raf = requestAnimationFrame(tick);
    };
    tick();
  });
}

async function revealObserved(): Promise<{ minOpacity: number; sawTransform: boolean }> {
  return overlay.evaluate(() => {
    const probe = window as unknown as {
      __reveal: { minOpacity: number; sawTransform: boolean; raf: number };
    };
    cancelAnimationFrame(probe.__reveal.raf);
    return { minOpacity: probe.__reveal.minOpacity, sawTransform: probe.__reveal.sawTransform };
  });
}

/** `CH-201`, which is how the renderer learns a session started or stopped. */
async function setSession(active: boolean, paused = false): Promise<void> {
  await pushToOverlay(app, 'state:session', {
    active,
    sessionId: active ? 'session-e2e' : null,
    profileName: active ? 'Acme' : null,
    startedAt: active ? new Date().toISOString() : null,
    paused,
  });
}

/* ------------------------------------------------------------------ *
 * TC-006  the consent reminder precedes the first suggestion
 * ------------------------------------------------------------------ */

/**
 * FR-006, FR-007, NFR-012. The reminder is on screen before any suggestion
 * renders, in **every** session, and it is dismissible without blocking
 * anything else.
 */
test('TC-006 the consent reminder renders before the first suggestion, every session', async () => {
  const reminder = overlay.locator('[data-testid="consent-reminder"]');
  await expect(reminder).toBeVisible();
  // FR-007: the default text says plainly that a local text transcript is kept.
  await expect(reminder).toContainText('transcript');
  // No suggestion has arrived, so nothing can have preceded it.
  await expect(overlay.locator('[data-testid="suggestion-card"]')).toHaveCount(0);

  await setSession(true);
  await generate('1', 'Tell me about a hard bug', ['Name the system', 'Name the fix']);
  await expect(overlay.locator('[data-testid="suggestion-card"]')).toHaveCount(1);
  // Still there: the reminder is not dismissed by a suggestion arriving.
  await expect(reminder).toBeVisible();

  // The reminder is *displayed*, not merely present. `OVERLAY_SIZE` is 420 by
  // 260 and cannot be resized, and scaling this card with the suggestion text
  // size once pushed it 2386 px above the viewport: a reminder nobody can read
  // does not satisfy `FR-006`. The shell keeps it out of the region that clips,
  // and the newest cue sits against the bottom of the window whatever is above
  // it, because the stack clips from the top.
  //
  // Both are polled, because the claim is about the **settled** layout. A card
  // enters under a transform, so a single read lands mid-animation: measured on
  // the built renderer, the newest card's bottom is 331 while it is still
  // travelling and 252 once it arrives, and the first CI run caught it at 332.
  const boxOf = async (selector: string): Promise<{ top: number; bottom: number; h: number }> =>
    overlay.locator(selector).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, h: box.height };
    });
  const viewport = await overlay.evaluate(() => window.innerHeight);

  await expect
    .poll(async () => {
      const box = await boxOf('[data-testid="consent-reminder"]');
      return box.h > 0 && box.top >= 0 && box.bottom <= viewport;
    })
    .toBe(true);

  await expect
    .poll(async () => (await boxOf('[data-testid="suggestion-card"][data-depth="0"]')).bottom)
    .toBeLessThanOrEqual(viewport);

  // FR-006: dismissible.
  await overlay.click('[data-testid="consent-dismiss"]');
  await expect(reminder).toHaveCount(0);

  // And back for the next session, because FR-006 says every session. A user
  // who dismissed it last interview has not consented to this one.
  await setSession(false);
  await setSession(true);
  await expect(reminder).toBeVisible();
  // The previous interview's cue does not survive the boundary either (ADR-036).
  await expect(overlay.locator('[data-testid="suggestion-card"]')).toHaveCount(0);
});

/**
 * FR-076: there is no error state in the overlay's component tree, so no push
 * it can receive produces one. Driven rather than read off the source, because
 * the claim is about what the window does with the messages it really gets.
 */
test('FR-076 no ending renders as an error', async () => {
  await setSession(true);
  for (const status of ['cancelled', 'nonconforming'] as const) {
    await pushToOverlay(app, 'suggestion:begin', {
      generationId: `gen-${status}`,
      cardId: `card-${status}`,
      question: 'A question',
    });
    await pushToOverlay(app, 'suggestion:line', {
      generationId: `gen-${status}`,
      cardId: `card-${status}`,
      line: 'What was salvaged',
      index: 0,
    });
    await pushToOverlay(app, 'suggestion:end', { generationId: `gen-${status}`, status });
  }

  // FR-004: what was salvaged is still shown, whatever the ending.
  await expect(overlay.locator('[data-testid="bullet"]').first()).toContainText('salvaged');
  await expect(overlay.locator('[role="alert"]')).toHaveCount(0);
  const body = (await overlay.locator('[data-testid="overlay"]').innerText()).toLowerCase();
  for (const word of ['error', 'failed', 'failure', 'retry', 'unavailable']) {
    expect(body, `the overlay said "${word}"`).not.toContain(word);
  }
});

/* ------------------------------------------------------------------ *
 * TC-110  the idle card
 * ------------------------------------------------------------------ */

test('TC-110 the idle card shows before the first suggestion and whenever paused', async () => {
  // FR-090: before the first suggestion.
  await expect(overlay.locator('[data-testid="idle-card"]')).toBeVisible();
  await expect(overlay.locator('[data-testid="overlay"]')).toHaveAttribute(
    'data-overlay-state',
    'idle',
  );

  await setSession(true);
  await generate('1', 'A question', ['A cue']);
  await expect(overlay.locator('[data-testid="idle-card"]')).toHaveCount(0);

  // FR-053, FR-090: and whenever the trigger is paused, over a card that exists.
  await pushToOverlay(app, 'overlay:mode', { interactive: false, paused: true });
  await expect(overlay.locator('[data-testid="idle-card"]')).toBeVisible();
  await expect(overlay.locator('[data-testid="idle-card"]')).toHaveAttribute('data-paused', 'true');
  await expect(overlay.locator('[data-testid="suggestion-card"]')).toHaveCount(0);

  // FR-102: an extended silence is this card, not an error and not a warning.
  await expect(overlay.locator('[role="alert"]')).toHaveCount(0);

  // Unpausing brings the cue back rather than leaving the user with nothing.
  await pushToOverlay(app, 'overlay:mode', { interactive: false, paused: false });
  await expect(overlay.locator('[data-testid="suggestion-card"]')).toHaveCount(1);
});

/* ------------------------------------------------------------------ *
 * TC-111  the three-card cap
 * ------------------------------------------------------------------ */

test('TC-111 a fourth suggestion leaves exactly three cards, the oldest gone', async () => {
  await setSession(true);
  for (const id of ['1', '2', '3']) await generate(id, `Question ${id}`, [`Cue ${id}`]);
  await expect(overlay.locator('[data-testid="suggestion-card"]')).toHaveCount(3);

  await generate('4', 'Question 4', ['Cue 4']);
  // FR-091, ASM-010. AnimatePresence keeps the leaving card mounted while it
  // fades, so the count is polled rather than read once: asserting immediately
  // would be asserting on the exit animation rather than on the cap.
  await expect(overlay.locator('[data-testid="suggestion-card"]')).toHaveCount(3);
  await expect(overlay.locator('[data-card-id="card-1"]')).toHaveCount(0);
  for (const id of ['2', '3', '4']) {
    await expect(overlay.locator(`[data-card-id="card-${id}"]`)).toHaveCount(1);
  }
});

/* ------------------------------------------------------------------ *
 * TC-112  reveal granularity
 * ------------------------------------------------------------------ */

/**
 * FR-092, NFR-007: one element per completed bullet, and no per-word reveal
 * anywhere. Counted against a line whose word count is far from its bullet
 * count, so a per-word implementation cannot coincide with the right answer.
 */
test('TC-112 a reveal is one element per bullet, never per word or per character', async () => {
  await setSession(true);
  await watchFirstBullet();
  const lines = [
    'Name the system and the symptom in one breath',
    'Say what you measured before you changed anything',
    'Close on the outcome, with a number if you have one',
  ];
  await generate('1', 'Tell me about a hard bug', lines);

  const bullets = overlay.locator('[data-testid="suggestion-card"] [data-testid="bullet"]');
  await expect(bullets).toHaveCount(lines.length);
  for (const [index, text] of lines.entries()) {
    await expect(bullets.nth(index)).toHaveText(text);
  }

  // Each bullet is one text node. A per-word reveal would have split it into an
  // element per word, which is what FR-092 forbids and what this counts.
  const elementsInside = await bullets.first().evaluate((el) => el.querySelectorAll('*').length);
  expect(elementsInside, 'a bullet contains child elements, which a word split would produce').toBe(
    0,
  );

  // FR-092: the reveal is a fade **plus** a slide, and it is observed rather
  // than inferred from where the bullet ended up. A build with no animation at
  // all settles exactly where an animated one does.
  const reveal = await revealObserved();
  expect(reveal.minOpacity, 'the bullet never faded in').toBeLessThan(1);
  expect(reveal.sawTransform, 'the bullet never slid').toBe(true);

  // NFR-007: nothing animates while idle. With no card on screen there is no
  // animating element for the compositor to be running at all.
  await pushToOverlay(app, 'overlay:mode', { interactive: false, paused: true });
  await expect(overlay.locator('[data-testid="overlay"]')).toHaveAttribute(
    'data-overlay-state',
    'idle',
  );
  // Polled rather than sampled once: a reveal still in flight when the pause
  // push landed is cancelled asynchronously, so a single read could catch it
  // mid-teardown. What `NFR-007` forbids is an animation that *keeps* running
  // while the overlay is idle.
  await expect
    .poll(async () =>
      overlay.evaluate(
        () => document.getAnimations().filter((a) => a.playState === 'running').length,
      ),
    )
    .toBe(0);
});

/* ------------------------------------------------------------------ *
 * TC-113  the font size
 * ------------------------------------------------------------------ */

/**
 * FR-093: 22 px by default, movable between 16 and 32 from the in-overlay
 * control **and** from the Dashboard, and persistent across a relaunch.
 *
 * The relaunch half reuses the first run's user data directory, because a page
 * reload would only prove the renderer re-read its own state.
 */
test('TC-113 the text size defaults to 22 px, moves from both controls and persists', async () => {
  const { min, max } = SETTINGS_LIMITS.overlayFontSizePx;

  const renderedSize = async (): Promise<number> =>
    overlay
      .locator('[data-testid="overlay"]')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));

  expect(await renderedSize()).toBe(22);

  // The Dashboard control first, while its own draft is still in step with the
  // stored value. Nothing pushes settings to the Dashboard, so driving the
  // overlay control first would leave that draft on 22 and the arrow keys would
  // move from there rather than from what the overlay had just written. The gap
  // is real and is carried as follow-up work; this case is about `FR-093`'s two
  // controls, not about the gap, so it does not walk into it.
  await dashboard.locator('[data-testid="overlay-font-size"]').focus();
  for (let i = 0; i < 2; i += 1) await dashboard.keyboard.press('ArrowRight');
  await expect(dashboard.locator('[data-testid="overlay-font-size-value"]')).toHaveText('24');
  await expect.poll(renderedSize).toBe(24);

  // And the in-overlay control, offered in interactive mode only, which is
  // where a click can reach it (FR-084). Its readout does not exist before
  // that, so it is read after the mode push rather than before it.
  await pushToOverlay(app, 'overlay:mode', { interactive: true, paused: false });
  await expect(overlay.locator('[data-testid="font-size-value"]')).toHaveText('24px');
  await overlay.click('[data-testid="font-larger"]');
  await expect(overlay.locator('[data-testid="font-size-value"]')).toHaveText('26px');
  await expect.poll(renderedSize).toBe(26);

  // It cannot leave the supported range, whichever end it is driven to. The
  // clicks stop exactly at the limit: the button disables itself there, and
  // Playwright waits for an element to be enabled before clicking, so one
  // press too many would hang the test rather than prove the clamp.
  const presses = (from: number, to: number): number => Math.abs(to - from) / FONT_STEP_PX;
  for (let i = 0; i < presses(26, max); i += 1) await overlay.click('[data-testid="font-larger"]');
  await expect(overlay.locator('[data-testid="font-size-value"]')).toHaveText(`${max}px`);
  await expect(overlay.locator('[data-testid="font-larger"]')).toBeDisabled();
  for (let i = 0; i < presses(max, min); i += 1)
    await overlay.click('[data-testid="font-smaller"]');
  await expect(overlay.locator('[data-testid="font-size-value"]')).toHaveText(`${min}px`);
  await expect(overlay.locator('[data-testid="font-smaller"]')).toBeDisabled();
  await expect.poll(renderedSize).toBe(min);

  // Persisted. The commit resolves asynchronously, so the stored value is
  // polled rather than assumed before the app is closed under it.
  await expect
    .poll(async () =>
      dashboard.evaluate(async () => {
        const settings = await window.copilot.invoke('config:get');
        return 'theme' in settings ? settings.theme.overlayFontSizePx : null;
      }),
    )
    .toBe(min);

  await app.close();
  ({ app, dashboard } = await launchApp(userDataDir));
  overlay = await overlayPage(app);
  await expect.poll(renderedSize).toBe(min);
});

/* ------------------------------------------------------------------ *
 * TC-115  reduced motion
 * ------------------------------------------------------------------ */

/**
 * NFR-010, FR-092: `prefers-reduced-motion: reduce` disables the slide and
 * keeps the fade.
 *
 * The preference is read at mount, so the page is reloaded after it is
 * emulated. The main process re-pushes the theme, the consent text and the mode
 * on `did-finish-load`, so the reloaded renderer is in the same state as a
 * fresh one.
 */
test('TC-115 reduced motion drops the slide and keeps the fade', async () => {
  await overlay.emulateMedia({ reducedMotion: 'reduce' });
  await overlay.reload();
  await overlay.waitForSelector('[data-testid="overlay"]');
  await expect(overlay.locator('[data-testid="overlay"]')).toHaveAttribute(
    'data-reduced-motion',
    'true',
  );

  await setSession(true);
  await watchFirstBullet();
  await generate('1', 'A question', ['A cue']);
  const bullet = overlay.locator('[data-testid="bullet"]').first();
  await expect(bullet).toHaveAttribute('data-slide', 'off');

  // The slide is a transform, so its absence is the absence of one. `none` and
  // an identity matrix both count: neither moves the text. Polled for the same
  // reason the geometry in `TC-006` is: a read taken while anything is still
  // settling is a read of a frame, not of the state under test.
  await expect
    .poll(async () => bullet.evaluate((el) => getComputedStyle(el).transform))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);

  // The fade remains, and that is observed rather than inferred. A settled
  // opacity of 1 is what a bullet that was never animated shows too, so
  // asserting only the end state would pass against a build that dropped the
  // fade along with the slide, which is the half `NFR-010` keeps.
  await expect.poll(async () => bullet.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  const reveal = await revealObserved();
  expect(reveal.minOpacity, 'reduced motion dropped the fade as well as the slide').toBeLessThan(1);
  expect(reveal.sawTransform, 'reduced motion still moved the text').toBe(false);
});

/* ------------------------------------------------------------------ *
 * TC-116  live theme apply
 * ------------------------------------------------------------------ */

/**
 * FR-085, FR-029: theme mode, translucency mode and opacity all reach the
 * overlay with no **app** restart.
 *
 * Mode and opacity apply in place. Translucency cannot: acrylic and
 * transparency are mutually exclusive window constructions, so `ADR-015`
 * destroys the overlay and builds a new one. That the rebuilt window comes back
 * in the new mode is this case's; that it keeps its position, its monitor, its
 * click-through state and its card stack is `TC-142`'s.
 */
test('TC-116 theme mode, opacity and translucency apply with no app restart', async () => {
  await dashboard.selectOption('[data-testid="theme-mode"]', 'dark');
  await expect(overlay.locator('[data-testid="overlay"]')).toHaveAttribute('data-theme', 'dark');

  await dashboard.selectOption('[data-testid="theme-mode"]', 'light');
  await expect(overlay.locator('[data-testid="overlay"]')).toHaveAttribute('data-theme', 'light');

  const surfaceAlpha = async (): Promise<number> =>
    overlay
      .locator('[data-testid="overlay"]')
      .evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).getPropertyValue('--overlay-chrome-alpha')),
      );

  const before = await surfaceAlpha();
  await dashboard.locator('[data-testid="overlay-opacity"]').focus();
  for (let i = 0; i < 3; i += 1) await dashboard.keyboard.press('ArrowLeft');
  await expect.poll(surfaceAlpha).toBeLessThan(before);

  // FR-094: the card's colours are the custom properties `theme.ts` computes,
  // resolved through the Tailwind stylesheet. Asserted on a resolved colour
  // rather than on a stylesheet element existing, which any build satisfies.
  //
  // Both serialisations are accepted. `color-mix(in srgb, …)` computes to
  // `color(srgb r g b / a)` in current Chromium rather than to `rgba(…)`, and
  // which one a build emits is the browser's business, not this card's.
  const surface = await overlay
    .locator('[data-testid="idle-card"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(surface, 'the card has no resolved background colour').toMatch(/^(rgba?|color)\(/);
  // Translucent, and not invisible: `FR-090` calls for a translucent card, so
  // an alpha of exactly 0 is as wrong as no colour at all.
  expect(surface, 'the card is fully transparent').not.toMatch(/\/\s*0\s*\)$|^rgba\(0, 0, 0, 0\)$/);

  // And the translucency mode, which rebuilds the window rather than applying
  // in place (ADR-015).
  await expect(overlay.locator('[data-testid="overlay"]')).toHaveAttribute(
    'data-translucency',
    'opacity',
  );
  const doomed = overlay;
  await dashboard.selectOption('[data-testid="overlay-translucency"]', 'acrylic');
  // Waiting for a page that is **not** the old one. The destroy happens on the
  // far side of a `config:set` round trip, so when `selectOption` returns the
  // doomed window is still open and still matches.
  overlay = await overlayPage(app, doomed);
  // The runner is Windows 11, so `CH-216` reports acrylic as supported and the
  // effective mode is the requested one. On a build that cannot render it the
  // renderer would resolve back to `opacity`, which is the point of sending
  // `acrylicSupported` at all (ADR-038).
  await expect(overlay.locator('[data-testid="overlay"]')).toHaveAttribute(
    'data-translucency',
    'acrylic',
  );
  // The window was rebuilt and the app was not: the old page is really gone,
  // and the Dashboard that drove the change is still the one this test
  // launched.
  expect(doomed.isClosed()).toBe(true);
  await expect(dashboard.locator('[data-testid="dashboard-header"]')).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * TC-117  the mode affordance
 * ------------------------------------------------------------------ */

test('TC-117 click-through and interactive render a visibly different state', async () => {
  const shell = overlay.locator('[data-testid="overlay"]');

  await pushToOverlay(app, 'overlay:mode', { interactive: false, paused: false });
  await expect(shell).toHaveAttribute('data-interactive', 'false');
  // FR-083: no drag region while the window forwards mouse events, or it would
  // swallow clicks meant for the application behind it.
  await expect(shell).not.toHaveAttribute('data-drag-region', 'true');
  await expect(overlay.locator('[data-testid="font-size-control"]')).toHaveCount(0);
  const clickThroughBorder = await overlay
    .locator('[data-testid="idle-card"]')
    .evaluate((el) => getComputedStyle(el).borderColor);

  await pushToOverlay(app, 'overlay:mode', { interactive: true, paused: false });
  await expect(shell).toHaveAttribute('data-interactive', 'true');
  await expect(shell).toHaveAttribute('data-drag-region', 'true');
  await expect(overlay.locator('[data-testid="font-size-control"]')).toBeVisible();

  // The difference is visible, not only structural (FR-084).
  const interactiveBorder = await overlay
    .locator('[data-testid="idle-card"]')
    .evaluate((el) => getComputedStyle(el).borderColor);
  expect(interactiveBorder, 'the two modes look the same').not.toBe(clickThroughBorder);
});

/* ------------------------------------------------------------------ *
 * TC-138  the readiness gate, renderer half
 * ------------------------------------------------------------------ */

/**
 * FR-008, ADR-016.
 *
 * The buffering itself, including "a second generation while buffered discards
 * the first" and the full replay to a rebuilt renderer, is driven directly
 * against `OverlayGate` in `tests/unit/overlay-surface.test.ts`, where every
 * ordering can be built. It cannot be driven from here: nothing a test can
 * reach feeds the gate except a live session, which needs provider credentials
 * this suite has no way to supply, and delaying the overlay's renderer start
 * would need a switch the app does not have.
 *
 * What this case asserts is the half that needs a window: the reminder is
 * rendered before any suggestion reaches the screen, a whole generation
 * replayed to a renderer that never saw it live is reconstructed into a card,
 * and a second generation replaces the first rather than interleaving with it.
 */
test('TC-138 a replayed generation renders in full, after the reminder', async () => {
  // Readiness is reported only once the reminder has painted (ADR-016), so the
  // reminder existing before any card is the renderer's half of the gate.
  await expect(overlay.locator('[data-testid="consent-reminder"]')).toBeVisible();
  await expect(overlay.locator('[data-testid="suggestion-card"]')).toHaveCount(0);

  await setSession(true);

  // The whole of a generation, in the order the gate replays it.
  await generate('1', 'First question', ['First cue', 'Second cue']);
  await expect(overlay.locator('[data-card-id="card-1"] [data-testid="bullet"]')).toHaveCount(2);

  // A second generation is its own card. FR-054's rule is that the first is
  // discarded upstream; what the renderer must never do is put the second
  // generation's lines onto the first generation's card.
  await generate('2', 'Second question', ['Third cue']);
  await expect(overlay.locator('[data-card-id="card-1"] [data-testid="bullet"]')).toHaveCount(2);
  await expect(overlay.locator('[data-card-id="card-2"] [data-testid="bullet"]')).toHaveCount(1);
  await expect(overlay.locator('[data-card-id="card-2"] [data-testid="bullet"]')).toHaveText(
    'Third cue',
  );

  // A line whose begin never arrived is dropped, not rendered on the card that
  // happens to be on screen.
  await pushToOverlay(app, 'suggestion:line', {
    generationId: 'gen-9',
    cardId: 'card-9',
    line: 'orphan',
    index: 0,
  });
  await expect(overlay.locator('[data-testid="overlay"]')).not.toContainText('orphan');
});

/* ------------------------------------------------------------------ *
 * TC-142  FR-089's Dashboard half
 * ------------------------------------------------------------------ */

/**
 * FR-089: "on Windows 10 the acrylic option must be disabled in the Dashboard
 * with an explanatory note".
 *
 * The build is simulated by pushing `CH-216`, which is how the Dashboard learns
 * it on a real machine: the runner is Windows 11, so the only alternative would
 * be asserting the enabled branch and calling `FR-089` covered. The window
 * lifecycle half of `TC-142` stays with `TASK-005`.
 */
test('TC-142 the acrylic option is disabled on a Windows 10 build, with the reason', async () => {
  const acrylicOption = (page: Page) =>
    page.locator('[data-testid="overlay-translucency"] option[value="acrylic"]');
  const translucencyNote = (page: Page) => page.locator('[data-testid="translucency-note"]');

  // The real path first, with nothing pushed by the test. The renderer starts
  // at `acrylicSupported: false`, and the runner is Windows 11, so the option
  // is offered only if `reportPlatform` really delivered `CH-216` on this
  // window's own load. A simulated push can never check that half (ADR-038).
  await expect(acrylicOption(dashboard)).toBeEnabled();

  // The assertion above is the whole of the regression guard, and it is worth
  // being precise about why. `reportPlatform` now sends to the window that just
  // loaded rather than to both, so the Dashboard's own `did-finish-load`
  // listener is the only thing that can deliver `CH-216` here. That listener is
  // registered from `createDashboardWindow`'s `onCreated`, because `loadFile`
  // resolves from **inside** `did-finish-load`: wiring after the await attaches
  // it to an event that has already fired. With the old ordering this window
  // would receive nothing and the line above would fail.
  //
  // A reload exercises the same listener a second time, so a replay that
  // happened to work once is not mistaken for one that works on every load.
  await dashboard.reload();
  await dashboard.waitForSelector('[data-testid="dashboard-header"]');
  await expect(acrylicOption(dashboard)).toBeEnabled();

  // Then the Windows 10 branch, which the runner cannot be.
  await pushToDashboard(app, 'notice:platform', { windowsBuild: 19045, acrylicSupported: false });
  await expect(acrylicOption(dashboard)).toBeDisabled();
  await expect(translucencyNote(dashboard)).toContainText('Windows 11');
  await expect(translucencyNote(dashboard)).toContainText('19045');

  await pushToDashboard(app, 'notice:platform', { windowsBuild: 26100, acrylicSupported: true });
  await expect(acrylicOption(dashboard)).toBeEnabled();
  await expect(translucencyNote(dashboard)).not.toContainText('unavailable on this machine');
});

/* ------------------------------------------------------------------ *
 * NFR-012  the capture warning, beside the consent reminder
 * ------------------------------------------------------------------ */

/**
 * `NFR-012` puts the pre-19041 warning "alongside the consent reminder", which
 * is the overlay. `CH-215` was documented as targeting the overlay, pushed to
 * the Dashboard and missing from the overlay preload's allowlist, so all three
 * disagreed and the window the sentence is about could never show it
 * (TASK-032 follow-up, closed by TASK-043).
 */
test('NFR-012 the capture warning reaches the overlay, beside the reminder', async () => {
  const message = 'This version of Windows cannot hide the overlay from screen capture.';
  await pushToOverlay(app, 'notice:captureFidelity', { windowsBuild: 18363, message });

  const notice = overlay.locator(
    '[data-testid="consent-reminder"] [data-testid="capture-fidelity-notice"]',
  );
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('screen capture');

  // The Dashboard keeps it too: FR-089 reads the build number there, and the
  // overlay card is dismissible, so the Dashboard is where it can still be read.
  await pushToDashboard(app, 'notice:captureFidelity', { windowsBuild: 18363, message });
  await expect(dashboard.locator('[data-testid="capture-fidelity-notice"]')).toBeVisible();
});
