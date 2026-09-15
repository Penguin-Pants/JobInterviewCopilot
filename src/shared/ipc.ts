import { z } from 'zod';

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

const providerChoice = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

const credentialId = z.enum(['deepgram', 'openai', 'anthropic', 'elevenlabs']);
const docType = z.enum(['resume', 'company-notes', 'job-description']);
const transcriptSource = z.enum(['interviewer', 'candidate']);
const streamState = z.enum(['idle', 'starting', 'running', 'error']);

const validationResult = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
});

export const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  activeProfileId: z.string(),
  providers: z.object({
    stt: z.object({ primary: providerChoice, backup: providerChoice.nullable() }),
    llm: z.object({ primary: providerChoice, backup: providerChoice.nullable() }),
  }),
  theme: z.object({
    mode: z.enum(['light', 'dark', 'system']),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    overlayTranslucency: z.enum(['acrylic', 'opacity']),
    overlayOpacity: z.number(),
    overlayFontSizePx: z.number(),
  }),
  hotkeys: z.object({
    toggleInteraction: z.string().min(1),
    togglePause: z.string().min(1),
  }),
  trigger: z.object({
    turnEndGapMs: z.number(),
    minTurnWords: z.number(),
    minTurnChars: z.number(),
    candidateContextTurns: z.number(),
    candidateContextChars: z.number(),
  }),
  thresholds: z.object({
    costUsd: z.number(),
    timeMinutes: z.number(),
  }),
  consentReminderText: z.string(),
  overlayWindow: z.object({
    x: z.number().nullable(),
    y: z.number().nullable(),
    displayId: z.string().nullable(),
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
      status: z.enum(['complete', 'cancelled', 'nonconforming']),
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
 * CH-101 .. CH-120  renderer to main, request/response
 * ------------------------------------------------------------------ */

export const invokeChannels = {
  'config:get': { id: 'CH-101', payload: z.void(), response: settingsSchema },
  'config:set': {
    id: 'CH-102',
    payload: settingsSchema.partial(),
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
    payload: z.object({ docId: z.string(), docType }),
    response: documentRecord,
  },
  'doc:delete': { id: 'CH-111', payload: z.object({ docId: z.string() }), response: ok },
  'session:start': {
    id: 'CH-112',
    payload: z.void(),
    response: z.object({ sessionId: z.string() }),
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
} as const;

/* ------------------------------------------------------------------ *
 * CH-201 .. CH-214  main to renderer, push
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
  'model:download': {
    id: 'CH-214',
    payload: z.object({ percent: z.number(), done: z.boolean() }),
  },
  /**
   * The pre-19041 capture warning, shown once per session next to the consent
   * reminder rather than once per install (NFR-012).
   */
  'notice:captureFidelity': {
    id: 'CH-215',
    payload: z.object({ windowsBuild: z.number(), message: z.string() }),
  },
} as const;

/* ------------------------------------------------------------------ *
 * CH-301 .. CH-304  audio worker
 * ------------------------------------------------------------------ */

export const audioWorkerChannels = {
  'audio:start': {
    id: 'CH-301',
    payload: z.object({ streams: z.array(transcriptSource) }),
  },
  'audio:stop': { id: 'CH-302', payload: z.void() },
  'audio:chunk': {
    id: 'CH-303',
    // pcm is a transferred ArrayBuffer and is validated structurally, not by zod.
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

/** Error shape returned when a payload fails its schema. Never a raw throw (CMP-10). */
export interface IpcError {
  __ipcError: true;
  channel: string;
  message: string;
}

export function isIpcError(value: unknown): value is IpcError {
  return typeof value === 'object' && value !== null && '__ipcError' in value;
}
