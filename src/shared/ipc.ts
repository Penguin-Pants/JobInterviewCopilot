import { z } from 'zod';
import { SETTINGS_LIMITS } from './defaults.js';
import { findLlmProvider } from './registry/llm.js';
import { findSttProvider } from './registry/stt.js';
import {
  DEFAULT_PROMPT_ID,
  DEFAULT_PROMPT_NAME,
  MAX_CUSTOM_PROMPTS,
  MAX_PROMPT_NAME_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
} from './prompts.js';

/**
 * The IPC contract. Mirrors `docs/02-architecture.md` section 4.
 *
 * Every channel is declared once, here, with a zod schema for its payload and
 * its response. The router validates against these schemas and rejects anything
 * that fails, so an invalid payload is never forwarded to a handler (FR-086,
 * CMP-10, TC-002). Both sides import these types, so the preload bridge and the
 * main handlers cannot drift (TC-003).
 */

/* ------------------------------------------------------------------ *
 * Reusable shapes
 * ------------------------------------------------------------------ */

const ok = z.object({ ok: z.literal(true) });

/**
 * A provider choice for one capability (FR-037).
 *
 * The provider id must name an entry in that capability's registry. An unknown
 * id reached `credentialFor`, which throws, and that stopped bootstrap before
 * any window opened. The model id is not checked here: both catalogs can add
 * account-discovered models at runtime, so a model missing from the shipped
 * registry is not provably invalid (FR-118).
 */
function providerChoiceFor(capability: string, known: (providerId: string) => boolean) {
  return z.object({
    providerId: z
      .string()
      .min(1)
      .refine(known, {
        error: (issue) => `"${String(issue.input)}" is not a known ${capability} provider.`,
      }),
    modelId: z.string().min(1),
    effort: z.string().min(1).optional(),
  });
}

const sttChoice = providerChoiceFor('speech', (id) => findSttProvider(id) !== null);
const llmChoice = providerChoiceFor('suggestion', (id) => findLlmProvider(id) !== null);

const credentialId = z.enum(['deepgram', 'openai', 'anthropic', 'elevenlabs']);
const docType = z.enum(['resume', 'company-notes', 'job-description']);
const transcriptSource = z.enum(['interviewer', 'candidate']);
const streamState = z.enum(['idle', 'starting', 'running', 'error']);

const validationResult = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
});

const llmModelDescriptor = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  providerId: z.enum(['openai', 'anthropic']),
  releasedAt: z.string().nullable(),
  status: z.enum(['available', 'legacy', 'unavailable']),
  streamingText: z.boolean(),
  effort: z.object({ allowed: z.array(z.string()).min(1), default: z.string() }).nullable(),
  pricing: z.discriminatedUnion('known', [
    z.object({ known: z.literal(true), inputPerMTokUsd: z.number(), outputPerMTokUsd: z.number() }),
    z.object({ known: z.literal(false) }),
  ]),
});

const llmCatalogResult = z.object({
  providers: z.array(
    z.object({
      providerId: z.enum(['openai', 'anthropic']),
      displayName: z.string(),
      models: z.array(llmModelDescriptor),
      lastSuccessfulRefresh: z.string().nullable(),
      state: z.enum(['ready', 'fallback', 'missing-key', 'error']),
      message: z.string().optional(),
    }),
  ),
});

const sttCatalogModel = z.object({
  id: z.string(),
  displayName: z.string(),
  streaming: z.boolean(),
  supportsInterim: z.boolean(),
  supportsEndpointing: z.boolean(),
  supportsConfidence: z.boolean(),
  batchIntervalMs: z.number().optional(),
  audio: z.object({
    encoding: z.literal('linear16'),
    sampleRate: z.literal(16000),
    channels: z.literal(1),
  }),
  pricePerAudioMinuteUsd: z.number(),
  badge: z.string().optional(),
  providerId: z.string().optional(),
  providerDisplayName: z.string().optional(),
  releasedAt: z.string().optional(),
  catalogStatus: z.enum(['available', 'legacy', 'unavailable']).optional(),
  catalogSource: z.enum(['account', 'fallback']).optional(),
  priceKnown: z.boolean().optional(),
});
const sttCatalog = z.object({
  providers: z.array(
    z.object({
      providerId: z.string(),
      displayName: z.string(),
      source: z.enum(['account', 'fallback']),
      state: z.enum(['ready', 'stale', 'missing-key', 'fallback']),
      lastSuccessfulRefresh: z.string().nullable(),
      models: z.array(sttCatalogModel),
      message: z.string().optional(),
    }),
  ),
});

const customPrompt = z.object({
  // `DEFAULT_PROMPT_ID` names the shipped prompt. A custom entry carrying it
  // would render a duplicate option value and look editable, while
  // `promptForProfile` still resolves the id to the shipped prompt.
  id: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => value !== DEFAULT_PROMPT_ID, 'Prompt id is reserved.'),
  name: z
    .string()
    .max(MAX_PROMPT_NAME_CHARS)
    .refine((value) => value.trim().length > 0, 'Prompt name cannot be blank.'),
  systemPrompt: z
    .string()
    .max(MAX_SYSTEM_PROMPT_CHARS)
    .refine((value) => value.trim().length > 0, 'System prompt cannot be blank.'),
});

/**
 * A number inside one of `SETTINGS_LIMITS`' ranges (FR-033, TC-033).
 *
 * The stored shape is bounded, so a value outside its range is refused at the
 * IPC boundary like `CH-126`'s. A file on disk is clamped by `clampSettings`
 * before it meets this schema, so an old or hand-edited file is repaired
 * rather than quarantined.
 */
function inRange(limit: { readonly min: number; readonly max: number }): z.ZodNumber {
  return z.number().min(limit.min).max(limit.max);
}

export const settingsSchema = z.object({
  schemaVersion: z.literal(7),
  activeProfileId: z.string(),
  providers: z.object({
    stt: z.object({ primary: sttChoice, backup: sttChoice.nullable() }),
    llm: z.object({ primary: llmChoice, backup: llmChoice.nullable() }),
  }),
  llmModelCutoffs: z.object({
    openai: z.string().nullable(),
    anthropic: z.string().nullable(),
  }),
  customPrompts: z
    .array(customPrompt)
    .max(MAX_CUSTOM_PROMPTS)
    .superRefine((prompts, context) => {
      const ids = new Set<string>();
      const names = new Set<string>();
      for (const [index, prompt] of prompts.entries()) {
        const name = prompt.name.trim().toLocaleLowerCase();
        if (ids.has(prompt.id))
          context.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: 'Prompt ids must be unique.',
          });
        if (names.has(name))
          context.addIssue({
            code: 'custom',
            path: [index, 'name'],
            message: 'Prompt names must be unique.',
          });
        // The shipped prompt already owns this label in every picker.
        if (name === DEFAULT_PROMPT_NAME.toLocaleLowerCase())
          context.addIssue({
            code: 'custom',
            path: [index, 'name'],
            message: `${DEFAULT_PROMPT_NAME} is reserved for the shipped prompt.`,
          });
        ids.add(prompt.id);
        names.add(name);
      }
    }),
  profilePromptIds: z.record(z.string(), z.string()),
  theme: z.object({
    mode: z.enum(['light', 'dark', 'system']),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    overlayTranslucency: z.enum(['acrylic', 'opacity']),
    overlayOpacity: inRange(SETTINGS_LIMITS.overlayOpacity),
    overlayFontSizePx: inRange(SETTINGS_LIMITS.overlayFontSizePx).int(),
  }),
  hotkeys: z.object({
    toggleInteraction: z.string().min(1),
    togglePause: z.string().min(1),
  }),
  trigger: z.object({
    turnEndGapMs: inRange(SETTINGS_LIMITS.turnEndGapMs).int(),
    minTurnWords: inRange(SETTINGS_LIMITS.minTurnWords).int(),
    minTurnChars: inRange(SETTINGS_LIMITS.minTurnChars).int(),
    candidateContextTurns: inRange(SETTINGS_LIMITS.candidateContextTurns).int(),
    candidateContextChars: inRange(SETTINGS_LIMITS.candidateContextChars).int(),
  }),
  thresholds: z.object({
    costUsd: inRange(SETTINGS_LIMITS.costUsd),
    timeMinutes: inRange(SETTINGS_LIMITS.timeMinutes),
  }),
  consentReminderText: z
    .string()
    .trim()
    .min(SETTINGS_LIMITS.consentReminderChars.min)
    .max(SETTINGS_LIMITS.consentReminderChars.max),
  overlayWindow: z.object({
    x: z.number().nullable(),
    y: z.number().nullable(),
    // Null means "the shipped default size". See `Settings.overlayWindow`.
    width: inRange(SETTINGS_LIMITS.overlayWidthPx).int().nullable(),
    height: inRange(SETTINGS_LIMITS.overlayHeightPx).int().nullable(),
    displayId: z.string().nullable(),
    // The shipped default is true, the teleprompter behavior (FR-083).
    clickThrough: z.boolean(),
  }),
  firstRun: z.object({ modelDownloaded: z.boolean() }),
});

const documentRecord = z.object({
  id: z.string(),
  profileId: z.string(),
  originalFileName: z.string(),
  originalPath: z.string(),
  sourceFormat: z.enum(['md', 'pdf', 'docx']),
  derivedMarkdownPath: z.string().nullable(),
  docType,
  docTypeSource: z.enum(['auto', 'user']),
  contentHash: z.string(),
  embeddingKey: z.string(),
  chunkCount: z.number(),
  state: z.enum(['pending', 'converting', 'embedding', 'ready', 'error']),
  errorMessage: z.string().nullable(),
  extractionQuality: z.enum(['native', 'best-effort']),
  updatedAt: z.string(),
});

const profile = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  kbPath: z.string(),
  documents: z.array(documentRecord),
});

const usageRecord = z.object({
  sttAudioSeconds: z.object({ interviewer: z.number(), candidate: z.number() }),
  llmInputTokens: z.number(),
  llmOutputTokens: z.number(),
  estimatedUsd: z.number(),
  priceTableVersion: z.string(),
  // Defaulted rather than required, so a session written before the Cost Meter
  // existed still parses instead of taking the whole transcript down with it.
  estimateIncomplete: z.boolean().default(false),
  warningsIssued: z.array(z.enum(['cost', 'time'])),
});

const transcriptEntry = z.intersection(
  z.object({ seq: z.number() }),
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('turn'),
      source: transcriptSource,
      text: z.string(),
      at: z.string(),
    }),
    z.object({
      kind: z.literal('suggestion'),
      forQuestion: z.string(),
      bullets: z.array(z.string()),
      model: z.string(),
      providerId: z.string(),
      at: z.string(),
      status: z.enum(['complete', 'cancelled', 'nonconforming', 'stale']),
    }),
  ]),
);

const session = z.object({
  id: z.string(),
  profileId: z.string(),
  profileNameSnapshot: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  entries: z.array(transcriptEntry),
  usage: usageRecord,
  endReason: z.enum(['user', 'crash-recovered']).nullable(),
});

export const sessionSchema = session;

const sessionSummary = z.object({
  id: z.string(),
  profileId: z.string(),
  profileNameSnapshot: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  entryCount: z.number(),
  estimatedUsd: z.number(),
  endReason: z.enum(['user', 'crash-recovered']).nullable(),
});

/**
 * Embedding model lifecycle (ADR-011, ADR-026).
 *
 * `unavailable` is what makes TC-161 pass: a fresh install with no network gets
 * a named state with a reason and a retry, not a spinner and not a generic
 * error.
 */
const modelDownloadState = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-downloaded') }),
  z.object({ kind: z.literal('downloading'), percent: z.number() }),
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('unavailable'), reason: z.string() }),
]);

const healthState = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('using-primary') }),
  z.object({ kind: z.literal('retrying'), attempt: z.number() }),
  z.object({ kind: z.literal('using-backup') }),
  z.object({ kind: z.literal('degraded'), reason: z.string() }),
  z.object({
    kind: z.literal('config-required'),
    credentialId,
    reason: z.string(),
  }),
]);

/* ------------------------------------------------------------------ *
 * CH-101 .. CH-126  renderer to main, request/response
 * ------------------------------------------------------------------ */

export const invokeChannels = {
  'config:get': { id: 'CH-101', payload: z.void(), response: settingsSchema },
  /**
   * Every setting except the three another channel owns (FR-086).
   *
   * `hotkeys` belongs to `hotkey:rebind`, which registers the accelerator
   * before storing it; written here it was stored and never registered.
   * `overlayWindow` belongs to the overlay's geometry and mode channels, and
   * `activeProfileId` to `profile:activate`, which checks the profile exists.
   * `strict`, so a renderer sending one is told so instead of having it
   * silently dropped.
   */
  'config:set': {
    id: 'CH-102',
    payload: settingsSchema
      .omit({ hotkeys: true, overlayWindow: true, activeProfileId: true })
      .partial()
      .strict(),
    response: settingsSchema,
  },
  'secrets:set': {
    id: 'CH-103',
    payload: z.object({ provider: credentialId, key: z.string().min(1) }),
    response: validationResult,
  },
  'secrets:status': {
    id: 'CH-104',
    payload: z.void(),
    // Booleans only. No channel may carry a key back to a renderer (FR-022).
    response: z.object({
      deepgram: z.boolean(),
      openai: z.boolean(),
      anthropic: z.boolean(),
      elevenlabs: z.boolean(),
    }),
  },
  'llmCatalog:get': {
    id: 'CH-130',
    payload: z.void(),
    response: llmCatalogResult,
  },
  'llmCatalog:refresh': {
    id: 'CH-131',
    payload: z.void(),
    response: llmCatalogResult,
  },
  'dashboard:setPromptDirty': {
    id: 'CH-132',
    payload: z.object({ dirty: z.boolean() }),
    response: ok,
  },
  'catalog:stt': {
    id: 'CH-129',
    payload: z.object({ force: z.boolean().default(false) }),
    response: sttCatalog,
  },
  'profile:list': { id: 'CH-105', payload: z.void(), response: z.array(profile) },
  'profile:create': {
    id: 'CH-106',
    payload: z.object({ name: z.string().min(1) }),
    response: profile,
  },
  'profile:delete': { id: 'CH-107', payload: z.object({ id: z.string() }), response: ok },
  'profile:activate': { id: 'CH-108', payload: z.object({ id: z.string() }), response: ok },
  'doc:import': {
    id: 'CH-109',
    payload: z.object({ profileId: z.string(), paths: z.array(z.string()) }),
    response: z.array(documentRecord),
  },
  'doc:setType': {
    id: 'CH-110',
    /**
     * `'auto'` clears a user override and re-runs the guess (FR-079).
     *
     * Spec gap closed here: `docs/02-architecture.md` section 4 typed the payload
     * as `{ docId, docType }` over the closed `DocType` union, which left
     * FR-079's "resettable to auto" with no channel to travel on. A second
     * channel for it would have given the Dashboard two ways to set one field.
     * `profileId` is added for the same reason it is added below. Recorded in the
     * architecture document and in ADR-030.
     */
    payload: z.object({
      docId: z.string(),
      profileId: z.string(),
      docType: z.union([docType, z.literal('auto')]),
    }),
    response: documentRecord,
  },
  /**
   * `profileId` accompanies `docId` on every document channel (ADR-030).
   *
   * A document id alone would force the main process to scan every profile to
   * find its owner, and `kb/` being authoritative means a stale id can outlive
   * its record. Naming the profile makes the lookup one directory read and makes
   * FR-069's "exactly one profile" explicit at the boundary.
   */
  'doc:delete': {
    id: 'CH-111',
    payload: z.object({ docId: z.string(), profileId: z.string() }),
    response: ok,
  },
  /**
   * Start a session, or say which of four things to go and fix (FR-088).
   *
   * A refusal is an **answer**, not a failure, so it travels as a response
   * rather than as a thrown error. The router replaces every thrown error with
   * one generic message, which would make all four refusals identical and leave
   * `TC-104`'s "distinct, named reason" true only inside the Session Manager.
   * Recorded in the architecture document and in ADR-032.
   */
  'session:start': {
    id: 'CH-112',
    payload: z.void(),
    response: z.union([
      z.object({ sessionId: z.string() }),
      z.object({
        refused: z.enum([
          'session-active',
          'no-active-profile',
          'stt-key-missing',
          'llm-key-missing',
        ]),
        message: z.string(),
      }),
    ]),
  },
  'session:stop': {
    id: 'CH-113',
    payload: z.void(),
    response: z.object({ sessionId: z.string() }),
  },
  'session:list': {
    id: 'CH-114',
    payload: z.object({ profileId: z.string() }),
    response: z.array(sessionSummary),
  },
  'session:read': {
    id: 'CH-115',
    payload: z.object({ sessionId: z.string() }),
    response: session,
  },
  'session:delete': {
    id: 'CH-116',
    payload: z.object({ sessionId: z.string() }),
    response: ok,
  },
  'hotkey:rebind': {
    id: 'CH-117',
    payload: z.object({
      action: z.enum(['toggleInteraction', 'togglePause']),
      accelerator: z.string().min(1),
    }),
    response: z.union([ok, z.object({ error: z.string() })]),
  },
  'overlay:setInteractive': {
    id: 'CH-118',
    payload: z.object({ interactive: z.boolean() }),
    response: ok,
  },
  'overlay:savePosition': {
    id: 'CH-119',
    payload: z.object({ x: z.number(), y: z.number(), displayId: z.string() }),
    response: ok,
  },
  'consent:dismiss': { id: 'CH-120', payload: z.void(), response: ok },
  /**
   * Reset Overlay (FR-009, TC-148). Not in the original CH-1xx table; added
   * with FR-009 when the escape hatch was specified, and recorded in the
   * architecture document in the same change (DoD 9).
   */
  'overlay:reset': {
    id: 'CH-121',
    payload: z.void(),
    // Reports the position it applied, not just success. A bare ok cannot
    // distinguish "main computed the wrong place" from "Windows ignored the
    // move", and that distinction is the whole debugging cost of FR-009.
    response: z.object({
      ok: z.literal(true),
      x: z.number(),
      y: z.number(),
      displayId: z.string(),
    }),
  },
  /** Overlay reports it has mounted and rendered the consent card (FR-008, ADR-016). */
  'overlay:ready': { id: 'CH-122', payload: z.void(), response: ok },
  /**
   * Re-process a document in `error` without re-importing it (FR-079, ADR-030).
   *
   * Not in the original CH-1xx table. FR-079 requires the retry and no channel
   * carried it, so `doc:import` was the only way back, which would have made the
   * user find the original file again.
   */
  'doc:retry': {
    id: 'CH-123',
    payload: z.object({ docId: z.string(), profileId: z.string() }),
    response: documentRecord,
  },
  /**
   * Download the embedding model, or report why it cannot be (ADR-011, ADR-026).
   *
   * This is the retry action behind the "embedding model not downloaded" state
   * TC-161 asserts. `CH-214` pushes progress; this channel is how the renderer
   * asks for an attempt and learns the outcome (ADR-030).
   */
  'model:ensure': {
    id: 'CH-124',
    payload: z.void(),
    response: modelDownloadState,
  },
  /**
   * Choose documents in a main-process dialog and import them (ADR-037).
   *
   * `doc:import` takes an array of absolute paths the renderer supplies, which
   * is what drag and drop can offer and nothing else. This channel is the path
   * where the **main** process picks the files, so the Add documents button
   * never asks a renderer for a path at all. The dialog and the import are one
   * channel deliberately: returning the paths to the renderer so that it could
   * call `doc:import` would put them back under renderer control and close
   * nothing (TASK-042).
   *
   * What still bounds `doc:import` is the extension allowlist in `CMP-06`, not
   * `basename`. `basename` decides the name a copy lands under inside `kb/`; it
   * does not decide which files may be read.
   *
   * An empty array is the answer when the user cancels. A cancel is not an
   * error and must not render as one.
   */
  'doc:pickFiles': {
    id: 'CH-125',
    payload: z.object({ profileId: z.string() }),
    response: z.array(documentRecord),
  },
  /**
   * The in-overlay text size control (FR-093, TASK-043, DoD 9).
   *
   * `FR-093` requires the size to be adjustable from the overlay as well as
   * from the Dashboard, and to persist. The overlay cannot be handed
   * `config:set` to do it: that channel writes the whole settings object, and
   * the overlay preload is allowlisted precisely so a compromised overlay
   * renderer cannot rebind hotkeys or replace credentials (FR-086). So the
   * overlay gets one channel that can change one number.
   *
   * The range is the schema's, not the handler's, so a value outside
   * `SETTINGS_LIMITS.overlayFontSizePx` is refused at the boundary rather than
   * clamped somewhere further in, where the two limits could drift apart.
   */
  'overlay:setFontSize': {
    id: 'CH-126',
    payload: z.object({
      px: z
        .number()
        .int()
        .min(SETTINGS_LIMITS.overlayFontSizePx.min)
        .max(SETTINGS_LIMITS.overlayFontSizePx.max),
    }),
    response: ok,
  },
  /**
   * The in-overlay resize grip (`FR-081`, TASK-052).
   *
   * The overlay is frameless, and a frameless window has no border for the
   * operating system to resize by. Electron also warns that a `transparent`
   * window may stop working when it is made resizable, and the flat-opacity
   * translucency mode builds exactly such a window. So the window carries
   * `resizable: true` for the acrylic case, and the renderer carries a grip
   * that drives this channel for every case. One of the two always works, and
   * the grip behaves the same in both, which is what keeps the two modes from
   * being two different products.
   *
   * It exists rather than `config:set` for the same reason `CH-126` does: one
   * channel that can change two numbers cannot be turned into a settings write
   * (FR-086). The range is the schema's, so an out-of-range value is refused at
   * the boundary rather than clamped further in.
   */
  'overlay:setSize': {
    id: 'CH-127',
    payload: z.object({
      width: z
        .number()
        .int()
        .min(SETTINGS_LIMITS.overlayWidthPx.min)
        .max(SETTINGS_LIMITS.overlayWidthPx.max),
      height: z
        .number()
        .int()
        .min(SETTINGS_LIMITS.overlayHeightPx.min)
        .max(SETTINGS_LIMITS.overlayHeightPx.max),
    }),
    response: ok,
  },
  /**
   * Whether the pointer is over one of the overlay's own controls (`FR-006`,
   * `FR-081`, `FR-083`, TASK-052).
   *
   * The consent reminder has to be clickable and so does the resize grip, and a
   * `BrowserWindow` is a rectangle: the only way to make either receive a click
   * is to stop the whole window ignoring mouse events, which then intercepts
   * clicks meant for the application behind every other part of the overlay.
   * `FR-006` says the reminder must not block interaction with other
   * applications, so the window follows the pointer instead: clickable over a
   * control, click-through everywhere else.
   *
   * This is what `setIgnoreMouseEvents`'s `forward: true` exists for. A window
   * that ignores mouse events still delivers **move** events to its renderer,
   * so the renderer can say where the pointer is even while the window is
   * passing clicks through.
   *
   * It fails safe where it matters. The main process starts each consent
   * reminder assuming the pointer is over it, so a renderer that never reports
   * leaves the reminder dismissible rather than dead. Outside a reminder it
   * starts click-through, because a grip nobody is pointing at has no claim on
   * the user's clicks.
   */
  'overlay:setPointerOverControls': {
    id: 'CH-128',
    payload: z.object({ over: z.boolean() }),
    response: ok,
  },
} as const;

/* ------------------------------------------------------------------ *
 * CH-201 .. CH-216  main to renderer, push
 * ------------------------------------------------------------------ */

export const pushChannels = {
  'state:session': {
    id: 'CH-201',
    payload: z.object({
      active: z.boolean(),
      sessionId: z.string().nullable(),
      profileName: z.string().nullable(),
      startedAt: z.string().nullable(),
      paused: z.boolean(),
    }),
  },
  'state:providers': {
    id: 'CH-202',
    payload: z.object({ stt: healthState, llm: healthState }),
  },
  'state:audio': {
    id: 'CH-203',
    payload: z.object({ interviewer: streamState, candidate: streamState }),
  },
  'state:usage': {
    id: 'CH-204',
    payload: z.intersection(usageRecord, z.object({ elapsedSeconds: z.number() })),
  },
  'usage:warning': {
    id: 'CH-205',
    payload: z.object({
      kind: z.enum(['cost', 'time']),
      value: z.number(),
      threshold: z.number(),
    }),
  },
  'transcript:live': {
    id: 'CH-206',
    payload: z.object({
      source: transcriptSource,
      text: z.string(),
      isFinal: z.boolean(),
      timestamp: z.number(),
      providerId: z.string(),
    }),
  },
  'suggestion:begin': {
    id: 'CH-207',
    payload: z.object({
      generationId: z.string(),
      cardId: z.string(),
      question: z.string(),
    }),
  },
  'suggestion:line': {
    id: 'CH-208',
    payload: z.object({
      generationId: z.string(),
      cardId: z.string(),
      line: z.string(),
      index: z.number(),
    }),
  },
  'suggestion:end': {
    id: 'CH-209',
    payload: z.object({
      generationId: z.string(),
      status: z.enum(['complete', 'cancelled', 'nonconforming']),
    }),
  },
  'overlay:consent': { id: 'CH-210', payload: z.object({ text: z.string() }) },
  'overlay:theme': {
    id: 'CH-211',
    payload: settingsSchema.shape.theme,
  },
  'overlay:mode': {
    id: 'CH-212',
    payload: z.object({ interactive: z.boolean(), paused: z.boolean() }),
  },
  'rag:progress': {
    id: 'CH-213',
    payload: z.object({
      docId: z.string(),
      state: z.enum(['pending', 'converting', 'embedding', 'ready', 'error']),
      percent: z.number(),
    }),
  },
  /**
   * Model download progress (FR-066, ADR-011, ADR-026, ADR-030).
   *
   * Spec change: the payload was `{ percent, done }`, which can say "not
   * finished" but cannot say "failed, here is why, you may retry". It now
   * carries the same state `CH-124` returns, so the push and the request cannot
   * describe the same model differently.
   */
  'model:download': {
    id: 'CH-214',
    payload: modelDownloadState,
  },
  /**
   * The pre-19041 capture warning, shown once per session next to the consent
   * reminder rather than once per install (NFR-012).
   */
  'notice:captureFidelity': {
    id: 'CH-215',
    payload: z.object({ windowsBuild: z.number(), message: z.string() }),
  },
  /**
   * What the host platform supports, pushed on every renderer load (FR-089,
   * ADR-038, TASK-043, DoD 9).
   *
   * Two windows need this and neither could ask for it. `FR-089` requires the
   * Dashboard to disable the acrylic option on Windows 10 with a note, and
   * `CH-215` was the only channel carrying a build number: it fires only when
   * capture fidelity is degraded, so a Windows 10 machine on build 19045 got
   * no build number at all and the option stayed enabled.
   *
   * The overlay needs it for a different reason. `overlayWindowOptions` falls
   * back to a transparent window when acrylic is selected on a build that
   * cannot render it, so the stored translucency and the window actually built
   * can disagree, and the overlay would style a transparent window as if it
   * were acrylic. `acrylicSupported` is what lets the renderer resolve the
   * **effective** mode, which is the one its contrast depends on (FR-093).
   *
   * Nothing about it is a failure: it describes the machine, so it is not an
   * error channel and the overlay may receive it (FR-076).
   */
  'notice:platform': {
    id: 'CH-216',
    payload: z.object({ windowsBuild: z.number(), acrylicSupported: z.boolean() }),
  },
  /**
   * A session-level fault the user has to be told about (`NFR-008`, `FR-102`,
   * `TASK-050`, `TC-132`).
   *
   * `CMP-15` reports every failure it survives through `onError`, and until this
   * channel existed the whole of that went to `main.log`. The one that must not:
   * a session that starts with no usable speech-to-text model runs, records and
   * bills, and never transcribes a word. `NFR-008` requires a session start with
   * no network to **warn**, and a log line the user will never open is not a
   * warning.
   *
   * Not on the health badges, deliberately. `CMP-12` is keyed by credential and
   * describes a provider that is failing; these are configuration faults that
   * never reach a provider, and routing them through `runFor` would take a
   * perfectly good key to `CONFIG_REQUIRED` (`ADR-024`).
   *
   * Dashboard only. The overlay never shows a failure (`FR-076`).
   *
   * The payload names the session it belongs to, so the renderer can show it
   * only while that session is the live one. Clearing on a session boundary
   * instead would race: `session:start` pushes `CH-201` before it brings the
   * loop up, so the clear and the notice arrive in that order and a clearing
   * effect would wipe the message it was sent to replace.
   */
  'notice:session': {
    id: 'CH-217',
    payload: z.object({ sessionId: z.string(), message: z.string() }),
  },
  'state:llmCatalog': {
    id: 'CH-218',
    payload: llmCatalogResult,
  },
} as const;

/* ------------------------------------------------------------------ *
 * CH-301 .. CH-304  audio worker
 * ------------------------------------------------------------------ */

/**
 * The largest PCM buffer `CH-303` accepts (ADR-027).
 *
 * The worker sends one second per chunk, 32,000 bytes at 16 kHz, 16-bit mono.
 * Twice that leaves room for a flush that ends late and still refuses a buffer
 * that is not a chunk.
 */
export const MAX_PCM_CHUNK_BYTES = 64_000;

export const audioWorkerChannels = {
  'audio:start': {
    id: 'CH-301',
    payload: z.object({ streams: z.array(transcriptSource) }),
  },
  'audio:stop': { id: 'CH-302', payload: z.void() },
  'audio:chunk': {
    id: 'CH-303',
    // pcm arrives as an ArrayBuffer (a structured-clone copy, ADR-027). It is
    // checked by `handleWorkerMessage`, not by zod: an ArrayBuffer, non-empty,
    // a whole number of 16-bit samples and at most MAX_PCM_CHUNK_BYTES.
    payload: z.object({
      source: transcriptSource,
      timestamp: z.number(),
      sequence: z.number(),
    }),
  },
  'audio:streamState': {
    id: 'CH-304',
    payload: z.object({
      source: transcriptSource,
      state: streamState,
      error: z.string().optional(),
    }),
  },
} as const;

export type InvokeChannel = keyof typeof invokeChannels;
export type PushChannel = keyof typeof pushChannels;
export type AudioWorkerChannel = keyof typeof audioWorkerChannels;

export type InvokePayload<C extends InvokeChannel> = z.infer<(typeof invokeChannels)[C]['payload']>;
export type InvokeResponse<C extends InvokeChannel> = z.infer<
  (typeof invokeChannels)[C]['response']
>;
export type PushPayload<C extends PushChannel> = z.infer<(typeof pushChannels)[C]['payload']>;

export const INVOKE_CHANNEL_NAMES = Object.keys(invokeChannels) as InvokeChannel[];
export const PUSH_CHANNEL_NAMES = Object.keys(pushChannels) as PushChannel[];

/* ------------------------------------------------------------------ *
 * Which window may use which channel (FR-086, CMP-10, ADR-057)
 * ------------------------------------------------------------------ */

/**
 * One table, enforced twice. The main-process router checks every invoke
 * against it by the `webContents` that sent it. Each preload keeps a literal
 * allowlist too, held equal to this table by a test (`ipc-sender.test.ts`): a
 * sandboxed preload cannot load a module shared with another preload, so it
 * cannot import this one. The preload check alone was never a boundary, since
 * it runs inside the renderer it is meant to restrict.
 *
 * `satisfies Record<...>` makes both tables exhaustive. A channel added to the
 * contract fails typecheck here until someone decides which window may use it.
 */
export type IpcWindowRole = 'dashboard' | 'overlay';

const DASHBOARD = ['dashboard'] as const;
const OVERLAY = ['overlay'] as const;
const BOTH = ['dashboard', 'overlay'] as const;

/**
 * The Dashboard is the configuration surface, so it gets every channel that
 * changes settings, credentials, profiles, documents or sessions.
 *
 * The overlay gets six, and each exists so the overlay never needs
 * `config:set`. `overlay:setFontSize` (FR-093) and `overlay:setSize` (FR-081)
 * can each change one or two numbers in a range the contract's schema enforces
 * (CH-126, CH-127). `overlay:setPointerOverControls` writes nothing; it reports
 * whether the pointer is over one of the overlay's own controls, so the window
 * is clickable there and click-through everywhere else (CH-128, FR-006,
 * FR-083).
 */
export const INVOKE_ACCESS = {
  'config:get': DASHBOARD,
  'config:set': DASHBOARD,
  'secrets:set': DASHBOARD,
  'secrets:status': DASHBOARD,
  'llmCatalog:get': DASHBOARD,
  'llmCatalog:refresh': DASHBOARD,
  'dashboard:setPromptDirty': DASHBOARD,
  'catalog:stt': DASHBOARD,
  'profile:list': DASHBOARD,
  'profile:create': DASHBOARD,
  'profile:delete': DASHBOARD,
  'profile:activate': DASHBOARD,
  'doc:import': DASHBOARD,
  'doc:setType': DASHBOARD,
  'doc:delete': DASHBOARD,
  'doc:retry': DASHBOARD,
  'doc:pickFiles': DASHBOARD,
  'model:ensure': DASHBOARD,
  'session:start': DASHBOARD,
  'session:stop': DASHBOARD,
  'session:list': DASHBOARD,
  'session:read': DASHBOARD,
  'session:delete': DASHBOARD,
  'hotkey:rebind': DASHBOARD,
  'overlay:setInteractive': DASHBOARD,
  'overlay:reset': DASHBOARD,
  'overlay:ready': OVERLAY,
  'overlay:savePosition': OVERLAY,
  'consent:dismiss': OVERLAY,
  'overlay:setFontSize': OVERLAY,
  'overlay:setSize': OVERLAY,
  'overlay:setPointerOverControls': OVERLAY,
} as const satisfies Record<InvokeChannel, readonly IpcWindowRole[]>;

/**
 * The overlay receives no error channel. It has two states, idle and
 * suggestions, and no error state (FR-076, TC-096).
 *
 * Two notices reach it, and neither is an error. `notice:captureFidelity`
 * belongs beside the consent reminder, which is in the overlay (NFR-012).
 * `notice:platform` describes the machine, and the overlay needs it to know
 * whether the acrylic it asked for is the window it got (CH-216, ADR-038).
 *
 * `overlay:mode` reaches the Dashboard too: it shows the mode as a checkbox and
 * the hotkey can change it while the Dashboard has focus (CH-212, FR-083).
 */
export const PUSH_ACCESS = {
  'state:session': BOTH,
  'state:providers': DASHBOARD,
  'state:audio': DASHBOARD,
  'state:usage': DASHBOARD,
  'usage:warning': DASHBOARD,
  'transcript:live': DASHBOARD,
  'suggestion:begin': OVERLAY,
  'suggestion:line': OVERLAY,
  'suggestion:end': OVERLAY,
  'overlay:consent': OVERLAY,
  'overlay:theme': OVERLAY,
  'overlay:mode': BOTH,
  'rag:progress': DASHBOARD,
  'model:download': DASHBOARD,
  'notice:captureFidelity': BOTH,
  'notice:platform': BOTH,
  'notice:session': DASHBOARD,
  'state:llmCatalog': DASHBOARD,
} as const satisfies Record<PushChannel, readonly IpcWindowRole[]>;

/** True when `role` may invoke `channel`. */
export function mayInvoke(role: IpcWindowRole, channel: InvokeChannel): boolean {
  return (INVOKE_ACCESS[channel] as readonly IpcWindowRole[]).includes(role);
}

/** Every invoke channel one window may use. */
export function invokeChannelsFor(role: IpcWindowRole): InvokeChannel[] {
  return (Object.keys(INVOKE_ACCESS) as InvokeChannel[]).filter((c) => mayInvoke(role, c));
}

/** Every push channel one window may receive. */
export function pushChannelsFor(role: IpcWindowRole): PushChannel[] {
  return (Object.keys(PUSH_ACCESS) as PushChannel[]).filter((c) =>
    (PUSH_ACCESS[c] as readonly IpcWindowRole[]).includes(role),
  );
}

/** Error shape returned when a payload fails its schema. Never a raw throw (CMP-10). */
export interface IpcError {
  __ipcError: true;
  channel: string;
  message: string;
}

export function isIpcError(value: unknown): value is IpcError {
  return typeof value === 'object' && value !== null && '__ipcError' in value;
}
