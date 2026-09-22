import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, openDashboardTab, pushToDashboard } from './launch.js';
import { STT_REGISTRY } from '../../src/shared/registry/stt.js';

/**
 * TASK-042 Dashboard UI: TC-120, TC-121, TC-122, TC-123, TC-124, TC-125,
 * TC-154, TC-158.
 *
 * Skipped off Windows, like the rest of the Electron suite. These drive real
 * windows, the real preload bridge and the real main-process handlers, and the
 * coverage policy makes E2E the only verification `src/renderer/**` gets
 * (ADR-004).
 */
test.skip(process.platform !== 'win32', 'Electron E2E runs on the Windows target only');

let app: ElectronApplication;
let dashboard: Page;
let userDataDir: string;

test.beforeEach(async () => {
  ({ app, dashboard, userDataDir } = await launchApp());
});

test.afterEach(async () => {
  await app.close();
});

/** The id of the profile the app creates on a fresh install. */
async function firstProfileId(): Promise<string> {
  const id = await dashboard
    .locator('[data-testid="profile-list"] > li')
    .first()
    .getAttribute('data-profile-id');
  expect(id, 'no profile row carried a profile id').toBeTruthy();
  return id as string;
}

async function createProfile(name: string): Promise<void> {
  await dashboard.fill('[data-testid="new-profile-name"]', name);
  await dashboard.click('[data-testid="create-profile"]');
  await expect(dashboard.locator('[data-testid="profile-list"]')).toContainText(name);
}

async function openTab(id: string): Promise<void> {
  await openDashboardTab(dashboard, id);
}

/* ------------------------------------------------------------------ *
 * TC-120  every section FR-087 names is on screen, one tab at a time
 * ------------------------------------------------------------------ */

test('TC-120 all Dashboard sections render behind their own tab, with the privacy and consent statements', async () => {
  const TAB_SECTIONS: [string, string[]][] = [
    ['profiles', ['section-company-profiles']],
    ['prompts', ['section-prompts']],
    ['history', ['section-session-history']],
    ['providers', ['section-provider-setup']],
    ['usage', ['section-cost-and-usage']],
    ['overlay', ['section-overlay']],
    // Hotkeys and Consent Reminder share the Preferences tab.
    ['preferences', ['section-hotkeys', 'section-consent-reminder']],
  ];

  for (const [tab, sectionIds] of TAB_SECTIONS) {
    await openTab(tab);
    for (const sectionId of sectionIds) {
      await expect(
        dashboard.locator(`[data-testid="${sectionId}"]`),
        `${tab}/${sectionId}`,
      ).toBeVisible();
    }
    // Every other tab's section is hidden while this one is open, not merely
    // unchecked: a tab that failed to hide its neighbours would still pass a
    // test that only asserted visibility of the one it opened.
    for (const [otherTab, otherSectionIds] of TAB_SECTIONS) {
      if (otherTab === tab) continue;
      for (const otherSectionId of otherSectionIds) {
        await expect(
          dashboard.locator(`[data-testid="${otherSectionId}"]`),
          `${otherSectionId} while on ${tab}`,
        ).toBeHidden();
      }
    }
  }

  // FR-110: Session History states plainly what a transcript is and how long
  // it is kept. Asserted on the words, not on the element merely existing.
  await openTab('history');
  const privacy = dashboard.locator(
    '[data-testid="section-session-history"] [data-testid="transcript-privacy-note"]',
  );
  await expect(privacy).toContainText('unencrypted');
  await expect(privacy).toContainText('until you delete them');

  // FR-032 and FR-110: the shipped default consent text says the same thing.
  await openTab('preferences');
  await expect(dashboard.locator('[data-testid="consent-text"]')).toHaveValue(
    /unencrypted local file/,
  );

  // FR-088: the session controls are explicit, and a session never starts on
  // its own, so Stop is unavailable until one is running. These sit in the
  // header, reachable no matter which tab is open.
  await expect(dashboard.locator('[data-testid="start-session"]')).toBeEnabled();
  await expect(dashboard.locator('[data-testid="stop-session"]')).toBeDisabled();

  // FR-027: which profile is active is stated in the header, not inferred.
  await expect(dashboard.locator('[data-testid="header-active-profile"]')).toContainText(
    'Active profile:',
  );
});

test('custom prompts can be saved and selected for a company profile', async () => {
  await openTab('prompts');
  await expect(dashboard.locator('[data-testid="prompt-text"]')).toContainText(
    'You are a live interview memory aid',
  );

  await dashboard.click('[data-testid="prompt-create"]');
  await dashboard.fill('[data-testid="prompt-name"]', 'Company-focused');
  await dashboard.fill(
    '[data-testid="prompt-text"]',
    'Focus on the company values and measured results.',
  );
  await dashboard.click('[data-testid="prompt-save"]');
  await dashboard.click('[data-testid="prompt-use-for-profile"]');
  await expect(dashboard.locator('[data-testid="prompt-status"]')).toContainText(
    'selected for the active profile',
  );

  await openTab('profiles');
  const profileId = await firstProfileId();
  await expect(dashboard.locator(`[data-testid="profile-prompt-${profileId}"]`)).toHaveValue(/.+/);
  await expect(dashboard.locator(`[data-testid="profile-${profileId}"]`)).toContainText(
    'Using Company-focused',
  );
});

/* ------------------------------------------------------------------ *
 * TC-121  provider constraints
 * ------------------------------------------------------------------ */

test('TC-121 a backup from the primary provider is blocked and the shared key is named', async () => {
  await openTab('providers');

  // FR-025. The backup starts as None, so it is selected first and then set to
  // the provider the primary already uses.
  const primary = await dashboard.locator('[data-testid="stt-primary-provider"]').inputValue();

  await dashboard.selectOption('[data-testid="stt-backup-provider"]', primary);

  await expect(dashboard.locator('[data-testid="stt-backup-conflict"]')).toBeVisible();
  await expect(dashboard.locator('[data-testid="stt-backup-conflict"]')).toContainText(
    'credential and the service are the same',
  );
  await expect(dashboard.locator('[data-testid="save-providers"]')).toBeDisabled();

  // Choosing a different provider clears the refusal and allows the save again.
  const other = STT_REGISTRY.find((p) => p.id !== primary);
  expect(other, 'the registry ships only one STT provider').toBeTruthy();
  await dashboard.selectOption('[data-testid="stt-backup-provider"]', other!.id);
  await expect(dashboard.locator('[data-testid="stt-backup-conflict"]')).toHaveCount(0);
  await expect(dashboard.locator('[data-testid="save-providers"]')).toBeEnabled();

  // ADR-017: one key serves both capabilities, and Provider Setup says so.
  const notice = dashboard.locator('[data-testid="shared-credential-notice"]');
  await expect(notice).toContainText('key serves');
  await expect(notice).toContainText('language models');
});

/* ------------------------------------------------------------------ *
 * TC-154  the model picker
 * ------------------------------------------------------------------ */

test('TC-154 each model shows streaming and price, and a non-streaming choice warns first', async () => {
  await openTab('providers');

  const batchProvider = STT_REGISTRY.find((p) => p.models.some((m) => !m.streaming));
  expect(batchProvider, 'no non-streaming model in the registry').toBeTruthy();
  const batchModel = batchProvider!.models.find((m) => !m.streaming)!;
  const streamingModel = batchProvider!.models.find((m) => m.streaming);

  await dashboard.selectOption('[data-testid="stt-primary-provider"]', batchProvider!.id);
  await expect(dashboard.locator('[data-testid="section-provider-setup"] .slot table')).toHaveCount(
    0,
  );

  // FR-038: every option states whether the model streams and what it costs.
  for (const model of batchProvider!.models) {
    const option = dashboard.locator(
      `[data-testid="stt-primary-model"] option[value="${model.id}"]`,
    );
    await expect(option).toContainText(model.streaming ? 'streams' : 'does not stream');
    await expect(option).toContainText(model.pricePerAudioMinuteUsd.toFixed(4));
  }

  // A streaming model says nothing about NFR-017, because it is not held to it.
  if (streamingModel) {
    await dashboard.selectOption('[data-testid="stt-primary-model"]', streamingModel.id);
    await expect(dashboard.locator('[data-testid="non-streaming-consequence"]')).toHaveCount(0);
  }

  await dashboard.selectOption('[data-testid="stt-primary-model"]', batchModel.id);

  // The consequence is on screen *before* the selection is saved: nothing has
  // been written yet, and the save control is a separate, deliberate action.
  const consequence = dashboard.locator('[data-testid="non-streaming-consequence"]');
  await expect(consequence).toBeVisible();
  await expect(consequence).toContainText('NFR-017');
  await expect(dashboard.locator('[data-testid="providers-saved"]')).toHaveCount(0);

  await dashboard.click('[data-testid="save-providers"]');
  await expect(dashboard.locator('[data-testid="providers-saved"]')).toBeVisible();

  // And it survives the round trip, because the stored choice is read back.
  // The reload resets to the default tab, so Provider Setup is opened again.
  await dashboard.reload();
  await dashboard.waitForSelector('[data-testid="dashboard-header"]');
  await openTab('providers');
  await expect(dashboard.locator('[data-testid="stt-primary-model"]')).toHaveValue(batchModel.id);
  await expect(dashboard.locator('[data-testid="non-streaming-consequence"]')).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * TC-122  profile delete confirmation
 * ------------------------------------------------------------------ */

test('TC-122 deleting a profile confirms with the document and session counts', async () => {
  // Company Profiles is the tab the Dashboard opens to; no navigation needed.
  await createProfile('Acme Corp');

  const row = dashboard.locator('[data-testid="profile-list"] > li', { hasText: 'Acme Corp' });
  const id = await row.getAttribute('data-profile-id');
  await dashboard.click(`[data-testid="profile-delete-${id}"]`);

  const confirm = dashboard.locator('[data-testid="delete-confirm"]');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Acme Corp');
  await expect(dashboard.locator('[data-testid="delete-confirm-counts"]')).toContainText(
    '0 documents',
  );
  await expect(dashboard.locator('[data-testid="delete-confirm-counts"]')).toContainText(
    '0 sessions',
  );

  // Declining keeps the profile. A confirmation that deletes either way is not
  // a confirmation.
  await dashboard.click('[data-testid="delete-confirm-no"]');
  await expect(confirm).toHaveCount(0);
  await expect(dashboard.locator('[data-testid="profile-list"]')).toContainText('Acme Corp');

  await dashboard.click(`[data-testid="profile-delete-${id}"]`);
  await dashboard.click('[data-testid="delete-confirm-yes"]');
  await expect(dashboard.locator('[data-testid="profile-list"]')).not.toContainText('Acme Corp');
});

/* ------------------------------------------------------------------ *
 * TC-123  session history
 * ------------------------------------------------------------------ */

test('TC-123 sessions group by profile, open for viewing and delete', async () => {
  const profileId = await firstProfileId();
  const profileName = await dashboard
    .locator('[data-testid="profile-list"] > li')
    .first()
    .locator('span')
    .first()
    .textContent();

  // Seeded on disk rather than recorded live: `session:start` refuses without a
  // provider key, and this case is about the history surface, not about
  // starting a session. The file is the one the Session Manager compacts to.
  const sessionId = 'e2e-history-1';
  const dir = join(userDataDir, 'profiles', profileId, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      profileId,
      profileNameSnapshot: profileName ?? 'My profile',
      startedAt: '2026-01-02T10:00:00.000Z',
      endedAt: '2026-01-02T10:30:00.000Z',
      entries: [
        {
          seq: 1,
          kind: 'turn',
          source: 'interviewer',
          text: 'Tell me about a hard problem you solved.',
          at: '2026-01-02T10:01:00.000Z',
        },
      ],
      usage: {
        sttAudioSeconds: { interviewer: 120, candidate: 90 },
        llmInputTokens: 1200,
        llmOutputTokens: 300,
        estimatedUsd: 0.0412,
        priceTableVersion: '2026-01-01',
        estimateIncomplete: false,
        warningsIssued: [],
      },
      endReason: 'user',
    }),
    'utf8',
  );

  await dashboard.reload();
  await dashboard.waitForSelector('[data-testid="dashboard-header"]');
  await openTab('history');

  // Grouped by profile: the row sits inside its profile's group, not in a flat
  // list that happens to mention the name.
  const group = dashboard.locator(`[data-testid="history-group-${profileId}"]`);
  await expect(group).toContainText(profileName ?? 'My profile');
  await expect(group.locator(`[data-testid="session-${sessionId}"]`)).toBeVisible();

  await dashboard.click(`[data-testid="session-view-${sessionId}"]`);
  await expect(dashboard.locator('[data-testid="session-viewer"]')).toContainText(
    'Tell me about a hard problem you solved.',
  );
  await dashboard.click('[data-testid="session-viewer-close"]');
  await expect(dashboard.locator('[data-testid="session-viewer"]')).toHaveCount(0);

  await dashboard.click(`[data-testid="session-delete-${sessionId}"]`);
  await expect(dashboard.locator(`[data-testid="session-${sessionId}"]`)).toHaveCount(0);
  await expect(dashboard.locator(`[data-testid="history-empty-${profileId}"]`)).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * TC-124  keyboard navigation
 * ------------------------------------------------------------------ */

test('TC-124 every interactive element is reachable by Tab and operable by Enter or Space', async () => {
  /**
   * Marks only controls sequential Tab could plausibly reach right now:
   * enabled, not hidden, and not deliberately taken out of the tab order.
   * `offsetParent === null` is what a `hidden` ancestor (a tab panel that is
   * not the active one) produces, so this also catches an element whose own
   * attributes look fine but whose panel is closed. `tabIndex === -1` is what
   * the sidebar's inactive tab buttons carry on purpose (a roving
   * tabindex): they are reached by Up/Down, not by Tab, which is asserted
   * separately below, so excluding them here is not a lowered bar, it is the
   * bar this pattern is supposed to have.
   */
  async function markReachableControls(): Promise<string[]> {
    return dashboard.evaluate(() => {
      const selector =
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';
      return [...document.querySelectorAll(selector)]
        .filter(
          (el) => (el as HTMLElement).offsetParent !== null && (el as HTMLElement).tabIndex !== -1,
        )
        .map((el, index) => {
          const mark = `kbd-${index}`;
          el.setAttribute('data-kbd', mark);
          return mark;
        });
    });
  }

  async function assertTabReachesEveryMark(marks: string[]): Promise<void> {
    await dashboard.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const reached = new Set<string>();
    for (let i = 0; i < marks.length + 5; i += 1) {
      await dashboard.keyboard.press('Tab');
      const mark = await dashboard.evaluate(() => document.activeElement?.getAttribute('data-kbd'));
      if (mark) reached.add(mark);
      if (reached.size === marks.length) break;
    }
    const missed = marks.filter((mark) => !reached.has(mark));
    expect(missed, `Tab never reached: ${missed.join(', ')}`).toEqual([]);
  }

  // Each tab in turn: with one panel visible at a time, Tab's whole path is
  // checked once per tab (header and sidebar included, since neither is ever
  // hidden) rather than once for what used to be the whole page.
  for (const tab of [
    'profiles',
    'prompts',
    'history',
    'providers',
    'usage',
    'overlay',
    'preferences',
  ]) {
    await openTab(tab);
    const marks = await markReachableControls();
    expect(marks.length, `${tab}: no reachable controls were marked`).toBeGreaterThan(0);
    await assertTabReachesEveryMark(marks);
  }

  // The sidebar itself follows the ARIA tabs pattern: only the active tab is a
  // Tab stop, and Up/Down move between tabs and activate immediately.
  await openTab('profiles');
  const profilesTab = dashboard.locator('[data-testid="tab-profiles"]');
  const promptsTab = dashboard.locator('[data-testid="tab-prompts"]');
  await profilesTab.focus();
  await dashboard.keyboard.press('ArrowDown');
  await expect(promptsTab).toHaveAttribute('aria-selected', 'true');
  await expect(dashboard.locator('[data-testid="section-prompts"]')).toBeVisible();
  // The sidebar moves focus to the newly selected tab from a
  // `requestAnimationFrame`, one frame after the handler returns, because the
  // button it moves to is not in the tab order until the re-render lands. That
  // deferred focus is part of the pattern under test, so it is asserted rather
  // than waited out: the next key can only be aimed once it has arrived.
  await expect(promptsTab).toBeFocused();
  await dashboard.keyboard.press('ArrowUp');
  await expect(profilesTab).toHaveAttribute('aria-selected', 'true');
  await expect(profilesTab).toBeFocused();

  // Operable by Enter. The empty name is refused, which is a visible result of
  // the press rather than a silent no-op. The key goes through the button's own
  // locator, which focuses and presses as one action, so nothing can take focus
  // in between and swallow it.
  const createProfile = dashboard.locator('[data-testid="create-profile"]');
  await createProfile.press('Enter');
  await expect(dashboard.locator('[data-testid="profile-error"]')).toBeVisible();

  // And by Space.
  await dashboard.fill('[data-testid="new-profile-name"]', 'Keyboard Co');
  await createProfile.press('Space');
  await expect(dashboard.locator('[data-testid="profile-list"]')).toContainText('Keyboard Co');
});

/* ------------------------------------------------------------------ *
 * TC-125  live cost and usage
 * ------------------------------------------------------------------ */

test('TC-125 the timer and the spend estimate render every usage tick, and invent none', async () => {
  // The live timer and spend live in the header now, not behind a tab, so
  // they read from whichever tab happens to be open (here, the default).
  const timer = dashboard.locator('[data-testid="live-timer"]');
  const spend = dashboard.locator('[data-testid="live-spend"]');
  await expect(timer).toHaveText('0:00:00');

  await pushToDashboard(app, 'state:session', {
    active: true,
    sessionId: 'e2e-usage-1',
    profileName: 'My profile',
    startedAt: '2026-01-02T10:00:00.000Z',
    paused: false,
  });
  await expect(dashboard.locator('[data-testid="header-session-state"]')).toHaveAttribute(
    'data-session-active',
    'true',
  );

  const usage = (elapsedSeconds: number, estimatedUsd: number): unknown => ({
    sttAudioSeconds: { interviewer: elapsedSeconds, candidate: elapsedSeconds },
    llmInputTokens: 100 * elapsedSeconds,
    llmOutputTokens: 20 * elapsedSeconds,
    estimatedUsd,
    priceTableVersion: '2026-01-01',
    estimateIncomplete: false,
    warningsIssued: [],
    elapsedSeconds,
  });

  await pushToDashboard(app, 'state:usage', usage(5, 0.25));
  await expect(timer).toHaveText('0:00:05');
  await expect(spend).toHaveText('$0.25');

  await pushToDashboard(app, 'state:usage', usage(6, 0.31));
  await expect(timer).toHaveText('0:00:06');
  await expect(spend).toHaveText('$0.31');

  // The Dashboard half of TC-125 is that both numbers are a pure function of
  // `CH-204`: the meter pushes once a second (its cadence is TC-108's, driven
  // directly in `tests/unit/cost.test.ts`), and the panel renders what it is
  // told. So it must not move on its own between pushes. A local timer would
  // drift away from the meter and would keep counting after a session stopped,
  // and asserting elapsed wall-clock here would have measured how fast this
  // test can send two messages rather than anything the app does.
  await dashboard.waitForTimeout(1500);
  await expect(timer).toHaveText('0:00:06');
  await expect(spend).toHaveText('$0.31');

  // The rest of the live detail stays on the Cost and Usage tab.
  await openTab('usage');
  await expect(dashboard.locator('[data-testid="price-table-version"]')).toHaveText('2026-01-01');
  await expect(dashboard.locator('[data-testid="estimate-incomplete"]')).toHaveCount(0);

  // ASM-011: a model with no price row labels the estimate rather than showing
  // a bare number that understates spend.
  await pushToDashboard(app, 'state:usage', {
    ...(usage(7, 0.31) as Record<string, unknown>),
    estimateIncomplete: true,
  });
  await expect(dashboard.locator('[data-testid="estimate-incomplete"]')).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * TC-132  the session warning reaches the screen
 * ------------------------------------------------------------------ */

test('TC-132 a session-level fault is shown, and only while its session is live', async () => {
  // The fault notice is Provider Setup's, since every fault this channel
  // carries is about a provider that could not be used.
  await openTab('providers');

  const notice = dashboard.locator('[data-testid="session-notice"]');
  await expect(notice).toHaveCount(0);

  await pushToDashboard(app, 'state:session', {
    active: true,
    sessionId: 'e2e-notice-1',
    profileName: 'My profile',
    startedAt: '2026-01-02T10:00:00.000Z',
    paused: false,
  });

  // The sentence CMP-15 produces when no speech-to-text model can be opened.
  // NFR-008 requires a session start with no network to warn, and until CH-217
  // existed this reached main.log and stopped there.
  const message =
    'transcription is unavailable: the speech-to-text model is not usable. ' +
    'The session is running, but nothing will be transcribed.';
  await pushToDashboard(app, 'notice:session', { sessionId: 'e2e-notice-1', message });

  await expect(notice).toBeVisible();
  // Capitalized for the screen; the loop writes lowercase for the log.
  await expect(notice).toContainText('Transcription is unavailable');
  // Warned, not stopped (FR-102, ADR-032).
  await expect(notice).toContainText('The session is still running.');
  await expect(notice).toHaveAttribute('role', 'alert');

  // A notice belongs to the session it names. The next session starts clean
  // rather than inheriting the last one's fault.
  await pushToDashboard(app, 'state:session', {
    active: true,
    sessionId: 'e2e-notice-2',
    profileName: 'My profile',
    startedAt: '2026-01-02T11:00:00.000Z',
    paused: false,
  });
  await expect(notice).toHaveCount(0);
});

/* ------------------------------------------------------------------ *
 * TC-158  profile lifecycle
 * ------------------------------------------------------------------ */

test('TC-158 create, switch and delete, with exactly one profile active', async () => {
  // Company Profiles is the tab the Dashboard opens to; no navigation needed.
  const original = await firstProfileId();
  await createProfile('Second Co');

  const secondRow = dashboard.locator('[data-testid="profile-list"] > li', {
    hasText: 'Second Co',
  });
  const second = (await secondRow.getAttribute('data-profile-id')) as string;

  // Creating does not activate. Exactly one profile is active throughout.
  await expect(dashboard.locator('[data-testid^="profile-active-"]')).toHaveCount(1);

  await dashboard.click(`[data-testid="profile-activate-${second}"]`);
  await expect(dashboard.locator(`[data-testid="profile-active-${second}"]`)).toBeVisible();
  await expect(dashboard.locator('[data-testid^="profile-active-"]')).toHaveCount(1);
  await expect(dashboard.locator('[data-testid="header-active-profile"]')).toContainText(
    'Second Co',
  );

  // FR-028: deleting the active profile activates another one.
  await dashboard.click(`[data-testid="profile-delete-${second}"]`);
  await dashboard.click('[data-testid="delete-confirm-yes"]');
  await expect(dashboard.locator(`[data-testid="profile-active-${original}"]`)).toBeVisible();
  await expect(dashboard.locator('[data-testid^="profile-active-"]')).toHaveCount(1);

  // And deleting the last one creates a default, so the app is never left with
  // no profile to address.
  await dashboard.click(`[data-testid="profile-delete-${original}"]`);
  await dashboard.click('[data-testid="delete-confirm-yes"]');
  await expect(dashboard.locator('[data-testid="profile-list"] > li')).toHaveCount(1);
  await expect(dashboard.locator('[data-testid^="profile-active-"]')).toHaveCount(1);

  // ADR-013: the profile is bound at session start, so switching and deleting
  // are disabled for the whole of a session.
  await createProfile('Third Co');
  await pushToDashboard(app, 'state:session', {
    active: true,
    sessionId: 'e2e-lock-1',
    profileName: 'My profile',
    startedAt: '2026-01-02T10:00:00.000Z',
    paused: false,
  });
  await expect(dashboard.locator('[data-testid="profile-switch-locked"]')).toBeVisible();
  const thirdRow = dashboard.locator('[data-testid="profile-list"] > li', { hasText: 'Third Co' });
  const third = (await thirdRow.getAttribute('data-profile-id')) as string;
  await expect(dashboard.locator(`[data-testid="profile-activate-${third}"]`)).toBeDisabled();
  await expect(dashboard.locator(`[data-testid="profile-delete-${third}"]`)).toBeDisabled();
});

/* ------------------------------------------------------------------ *
 * FR-029  the theme and overlay settings the Dashboard owns
 * ------------------------------------------------------------------ */

/**
 * `FR-029` is traced by this task but its test cases (TC-030, TC-033, TC-116)
 * all live elsewhere: two in the settings store and one in the overlay. Nothing
 * covered the Dashboard controls that write these values, and the continuous
 * ones commit on release rather than on every step, which is a path a store
 * test cannot reach.
 */
test('FR-029 theme and overlay settings are written and survive a reload', async () => {
  await openTab('overlay');

  await dashboard.selectOption('[data-testid="theme-mode"]', 'dark');
  // FR-080: the Dashboard itself follows the theme mode setting.
  await expect(dashboard.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Adjusted from the keyboard, which is both NFR-010's path and the one that
  // fires a burst of change events without a pointer release between them.
  await dashboard.locator('[data-testid="overlay-font-size"]').focus();
  const before = await dashboard.locator('[data-testid="overlay-font-size-value"]').textContent();
  for (let i = 0; i < 3; i += 1) await dashboard.keyboard.press('ArrowRight');
  const after = await dashboard.locator('[data-testid="overlay-font-size-value"]').textContent();
  expect(after, 'the size control did not move').not.toBe(before);

  // The commit is dispatched on key release and resolves asynchronously, so the
  // stored value is polled rather than assumed. Reloading straight after the
  // last key press raced the write and read back the previous size.
  await expect
    .poll(async () =>
      dashboard.evaluate(async () => {
        const settings = await window.copilot.invoke('config:get');
        return 'theme' in settings ? String(settings.theme.overlayFontSizePx) : null;
      }),
    )
    .toBe(after);

  await dashboard.reload();
  await dashboard.waitForSelector('[data-testid="dashboard-header"]');
  await openTab('overlay');
  await expect(dashboard.locator('[data-testid="theme-mode"]')).toHaveValue('dark');
  await expect(dashboard.locator('[data-testid="overlay-font-size-value"]')).toHaveText(
    after ?? '',
  );
});

/* ------------------------------------------------------------------ *
 * FR-088  the session controls, and what a live session binds
 * ------------------------------------------------------------------ */

/**
 * The Stop control and the locks a live session applies.
 *
 * `TC-120` asserts the idle half: Start offered, Stop unavailable because no
 * session has started. The live half had no case, and two defects lived there.
 * `TC-158` covers the profile lock; this covers the session controls themselves
 * and the provider lock (ADR-013).
 */
test('FR-088 Stop is available as soon as a session is live, and bindings lock', async () => {
  await openTab('providers');

  await expect(dashboard.locator('[data-testid="stop-session"]')).toBeDisabled();
  await expect(dashboard.locator('[data-testid="save-providers"]')).toBeEnabled();

  // The main process pushes this *before* it awaits the loop, deliberately: the
  // session is live the moment the manager accepts it, while capture and two
  // sockets are still coming up. Stop has to work for the whole of that, or a
  // slow permission prompt leaves a running interview with no way out.
  await pushToDashboard(app, 'state:session', {
    active: true,
    sessionId: 'e2e-controls-1',
    profileName: 'My profile',
    startedAt: '2026-01-02T10:00:00.000Z',
    paused: false,
  });

  await expect(dashboard.locator('[data-testid="stop-session"]')).toBeEnabled();
  await expect(dashboard.locator('[data-testid="start-session"]')).toBeDisabled();

  // The providers are bound for the session, as the profile is. Saving a new
  // selection mid-session rebinds the health registry while the STT sockets
  // stay on the old choice, so the badge would describe a configuration the
  // audio is not using.
  await expect(dashboard.locator('[data-testid="providers-locked"]')).toBeVisible();
  await expect(dashboard.locator('[data-testid="save-providers"]')).toBeDisabled();

  await pushToDashboard(app, 'state:session', {
    active: false,
    sessionId: null,
    profileName: null,
    startedAt: null,
    paused: false,
  });
  await expect(dashboard.locator('[data-testid="stop-session"]')).toBeDisabled();
  await expect(dashboard.locator('[data-testid="save-providers"]')).toBeEnabled();
});
