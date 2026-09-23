/**
 * The live session loop (`CMP-15`). Mirrors `docs/02-architecture.md`
 * sections 5.1 and 5.2 (TASK-044, ADR-034, ADR-035).
 *
 * Every component this file drives already existed and was unit-tested on its
 * own. What did not exist was the thing that joins them, so a `session:start`
 * opened no socket, fed the trigger nothing and accounted zero spend. This is
 * that join, and nothing else: it owns no policy of its own, it writes no file
 * and it creates no window.
 *
 * Deliberately free of Electron and of `node:fs`. The loop is the hardest part
 * of the app to observe in production, so it is driven end to end by tests with
 * an injected audio chunk, an injected STT transport and a fake LLM (`TC-164`).
 *
 * Two rules from ADR-032 shape the error handling below, because this loop
 * touches the transcript writer on every turn:
 *
 * - A failure stops and says so. It never substitutes a plausible value. A
 *   retrieval failure abandons the turn rather than generating an ungrounded
 *   suggestion the user cannot tell apart from a grounded one.
 * - Nothing here reaches the overlay with an error (`FR-076`, `FR-102`). Every
 *   failure goes to the log and to the Dashboard badge the health machine
 *   drives; the overlay keeps its idle card.
 */
import type {
  AudioChunk,
  HealthState,
  ProviderChoice,
  Settings,
  TranscriptEvent,
  TranscriptSource,
} from '../shared/types.js';
import { findSttModel } from '../shared/registry/stt.js';
import type { AudioSupervisor } from './audio.js';
import type { ProviderHealthRegistry } from './ai/health.js';
import { classifyWithLlm, type ActionabilityVerdict } from './ai/actionability.js';
import {
  requireLlmProvider,
  runGeneration,
  type GenerationOutcome,
  type LlmProvider,
} from './ai/llm.js';
import { openSttSession, providerError, type SttSession } from './ai/stt.js';
import type { TriggerMachine, TurnFired } from './ai/trigger.js';
import type { CostMeter } from './cost.js';
import type { GatedMessage } from './overlay-gate.js';
import type { RetrievedChunk } from './rag.js';
import type { SessionManager } from './session.js';
import { promptForProfile } from '../shared/prompts.js';

/** How many knowledge-base chunks one suggestion is built from (`FR-072`). */
export const RETRIEVAL_K = 3;
/** A suggestion older than this since its turn fired is not shown (FR-114, ASM-017). */
export const STALE_DISCARD_MS = 20_000;
/** The client-side budget for one classification call (FR-111, ASM-020). */
export const CLASSIFICATION_TIMEOUT_MS = 800;

/** Both streams, in the order they are opened and closed (`FR-040`, `FR-047`). */
const SOURCES: readonly TranscriptSource[] = ['interviewer', 'candidate'];

/** 16-bit signed PCM, so one sample is two bytes (`FR-041`). */
const BYTES_PER_SAMPLE = 2;

/**
 * How many seconds of audio a chunk carries.
 *
 * Computed from the chunk's own byte length and the sample rate the **selected
 * model's registry entry** declares, never from a constant here: the cost of a
 * short final chunk is the cost of a short final chunk, and a model shipped at
 * another sample rate needs no edit in this file (ADR-022).
 */
export function chunkSeconds(byteLength: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  return byteLength / (sampleRate * BYTES_PER_SAMPLE);
}

/** One STT stream the loop is holding open. */
interface OpenStream {
  session: SttSession;
  choice: ProviderChoice;
  sampleRate: number;
}

/** A transcription target that is usable: in the registry, and with a key. */
interface SttTarget {
  choice: ProviderChoice;
  key: string;
  sampleRate: number;
  /** The gap the provider is configured with, so `TC-159` holds end to end. */
  turnEndGapMs: number;
}

/** A language model that is usable: in the registry, with an adapter behind it. */
interface LlmTarget {
  choice: ProviderChoice;
  provider: LlmProvider;
}

/**
 * What the loop is wired to.
 *
 * Every collaborator is injected rather than imported as a singleton, so the
 * whole loop runs in a test with no Electron, no socket and no real model.
 */
export interface LiveSessionLoopOptions {
  audio: Pick<AudioSupervisor, 'start' | 'stop'>;
  trigger: Pick<
    TriggerMachine,
    'start' | 'stop' | 'handleTranscript' | 'handleEndpoint' | 'noteGenerationSettled'
  >;
  sessions: Pick<SessionManager, 'appendTurn' | 'appendSuggestion'>;
  cost: Pick<CostMeter, 'noteAudio' | 'noteGeneration'>;
  /**
   * The health machine. `for` is **required**, not optional: the classifier
   * reads the LLM primary's state through it, and an omitted `for` silently
   * disabled the classifier through an optional chain rather than failing.
   */
  health: Pick<ProviderHealthRegistry, 'runFor'> & {
    for: (capability: 'stt' | 'llm') => { current: HealthState };
  };
  /** The current settings, read at each start rather than captured once. */
  settings: () => Settings;
  /** `RagEngine.query`, narrowed to what the loop needs (`CMP-06`). */
  retrieve: (profileId: string, question: string, k: number) => Promise<RetrievedChunk[]>;
  /** The vault, by provider id. Never a copied key (`NFR-003`). */
  keyFor: (providerId: string) => string | undefined;
  /** `CH-206 transcript:live`. */
  onTranscript: (event: TranscriptEvent) => void;
  /** `CH-207`, `CH-208` and `CH-209`, through the readiness gate (`FR-008`). */
  onSuggestion: (message: GatedMessage) => void;
  /**
   * The model actually serving the session. The trigger's `supportsEndpointing`
   * and `batchIntervalMs` are rebound from it, because health can put the
   * session on the backup and the two models can disagree (TASK-030 follow-up).
   */
  onSttChoice: (choice: ProviderChoice | null) => void;
  onError: (message: string, detail?: unknown) => void;
  onInfo?: (message: string, detail?: unknown) => void;
  /** Test seams. Production uses the real facades. */
  openStt?: typeof openSttSession;
  generate?: typeof runGeneration;
  resolveLlmProvider?: (choice: ProviderChoice) => LlmProvider;
}

/**
 * Joins capture, transcription, the trigger, retrieval, generation, the overlay
 * gate, the transcript writer and the Cost Meter into one live session.
 */
export class LiveSessionLoop {
  private readonly options: LiveSessionLoopOptions;
  private readonly openStt: typeof openSttSession;
  private readonly generate: typeof runGeneration;
  private readonly resolveLlmProvider: (choice: ProviderChoice) => LlmProvider;

  private readonly streams = new Map<TranscriptSource, OpenStream>();
  private profileId: string | null = null;
  private systemPrompt: string | null = null;
  private sttChoice: ProviderChoice | null = null;

  /**
   * The turn currently being answered, or null.
   *
   * A promise rather than a flag, because the replacement of a cancelled
   * generation has to **await** the cancelled one's transcript append before
   * appending its own (`FR-106`, TC-134). Holding the promise is what makes
   * that ordering a mechanism rather than a hope about timing.
   */
  private generation: Promise<void> | null = null;
  private classification: Promise<void> | null = null;
  private classificationCounter = 0;

  /**
   * The start in flight, so `stop` cannot interleave with it (ADR-036).
   *
   * `session:start` tells the renderers the session is live before awaiting the
   * loop, so Stop can arrive while capture or a socket is still coming up.
   * Without this, `stop` cleared the state and closed what was open, and the
   * start then carried on and opened the pair again, leaving sockets live
   * against a transcript the Session Manager had already compacted.
   */
  private starting: Promise<void> | null = null;

  /** A re-open after a stream failure, serialized so two streams reopen once. */
  private reopening: Promise<void> | null = null;

  /**
   * True while the sockets are closing.
   *
   * The streams stay in the map across a close so a batch adapter's final
   * transcript is still routed, and this is what stops a *chunk* being pushed
   * into a socket that is on its way out.
   */
  private closing = false;

  constructor(options: LiveSessionLoopOptions) {
    this.options = options;
    this.openStt = options.openStt ?? openSttSession;
    this.generate = options.generate ?? runGeneration;
    this.resolveLlmProvider =
      options.resolveLlmProvider ?? ((choice) => requireLlmProvider(choice));
  }

  /** True between `start` and `stop`. */
  get isRunning(): boolean {
    return this.profileId !== null;
  }

  /** The model transcribing this session, or null when none is open. */
  get activeSttChoice(): ProviderChoice | null {
    return this.sttChoice;
  }

  /** How many streams are transcribing. Two in the healthy case (`FR-047`). */
  get openStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Resolves once the turn being answered has settled, or immediately when none
   * is.
   *
   * A test seam, and the honest one: a generation is a chain of awaits with no
   * timer in it, so a test that slept would be asserting on a guess. `stop`
   * uses the same promise, which is what keeps the two paths in step.
   */
  async whenSettled(): Promise<void> {
    try {
      await Promise.all([this.generation, this.classification]);
    } catch {
      // Reported where it happened. Waiting for a turn must not fail a caller.
    }
  }

  /**
   * Resolves once a re-open after a stream failure has finished, or immediately
   * when none is running. The counterpart of `whenSettled`, for the same
   * reason: the work is a chain of awaits with no timer to advance.
   */
  async whenReopened(): Promise<void> {
    try {
      await this.reopening;
    } catch {
      // Reported where it happened.
    }
  }

  /**
   * Bring the loop up for a session the Session Manager has already accepted
   * (`docs/02-architecture.md` section 5.1).
   *
   * Never throws. A session that has already been created on disk must not be
   * torn down by a capture or socket failure: `FR-102` and the error policy in
   * section 10 both put those on the Dashboard badge and leave the session
   * running, which is also what `TC-132` asks for with the network unplugged.
   */
  async start(profileId: string): Promise<void> {
    if (this.isRunning) throw new Error('the live session loop is already running');
    this.profileId = profileId;
    this.systemPrompt = promptForProfile(this.options.settings(), profileId);
    // Held before it is awaited, so a `stop` arriving during the bring-up has
    // something to wait for rather than a gap it can slip through.
    this.starting = this.bringUp();
    await this.starting;
  }

  private async bringUp(): Promise<void> {
    // Capture first. The STT sessions are opened next, and chunks that arrive
    // before they exist are dropped rather than queued: a queue with no
    // consumer is the unbounded PCM retention ADR-027 exists to prevent.
    try {
      await this.options.audio.start();
    } catch (err) {
      this.options.onError('audio capture could not be started', err);
    }

    await this.openTranscription();

    // Last, so the machine leaves IDLE only once there is something feeding it.
    this.options.trigger.start();
  }

  /**
   * Tear the loop down, in the one order that cannot append to a closed handle.
   *
   * The trigger stops first, which aborts the in-flight generation. That
   * generation is then awaited, so its cancelled entry reaches the transcript
   * while the writer is still open. Only then do the sockets close and capture
   * stop, and only after this returns may the Session Manager compact
   * (`FR-046`, `FR-107`).
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    // A start still coming up is finished first, rather than torn down from
    // underneath. Abandoning it half-way is what leaves a socket open against a
    // transcript that has been compacted: the start's own continuation would
    // re-open the pair after the teardown had run. `bringUp` never throws.
    const starting = this.starting;
    this.starting = null;
    if (starting) await starting;

    this.profileId = null;
    this.systemPrompt = null;

    this.options.trigger.stop();
    await Promise.all([this.settleGeneration(), this.settleClassification()]);
    await this.reopening;
    await this.closeStreams();

    try {
      await this.options.audio.stop();
    } catch (err) {
      this.options.onError('audio capture could not be stopped cleanly', err);
    }
  }

  /**
   * Drop everything without awaiting, for `will-quit`.
   *
   * The quit path cannot hold the app open, so this releases the sockets and
   * stops routing audio. Whatever an in-flight append does not finish is what
   * crash recovery is for (`FR-105`).
   */
  dispose(): void {
    this.profileId = null;
    this.systemPrompt = null;
    this.starting = null;
    this.options.trigger.stop();
    void this.closeStreams();
  }

  /**
   * One chunk of PCM (`CH-303`), routed to its stream's provider session.
   *
   * The reference is not retained: it is pushed and the function returns, which
   * is the supervisor's contract for its consumer (ADR-027). Seconds are
   * accounted **here**, where the audio is actually handed to a provider, so a
   * stream whose socket never opened bills nothing while the session timer runs
   * on (`FR-103`).
   */
  handleChunk(chunk: AudioChunk): void {
    if (this.closing) return;
    const stream = this.streams.get(chunk.source);
    if (!stream) return;

    const before = stream.session.sentBytes;
    stream.session.push(chunk);

    // What the adapter says it put on the wire, when it can say. A streaming
    // socket that is down drops queued chunks rather than buffering without
    // bound (ADR-027), and billing the chunk we handed over would charge an
    // outage as though it had been transcribed. An adapter with no counter
    // sends everything it is handed, so the chunk itself is the measurement.
    const seconds =
      before === undefined || stream.session.sentBytes === undefined
        ? chunkSeconds(chunk.pcm.byteLength, stream.sampleRate)
        : chunkSeconds(stream.session.sentBytes - before, stream.sampleRate);

    this.options.cost.noteAudio(chunk.source, stream.choice, seconds);
  }

  /* ---------------------------------------------------------------- *
   * Transcription
   * ---------------------------------------------------------------- */

  /**
   * Open one `SttSession` per stream, both on whichever credential health is
   * serving (`FR-047`, `FR-100`).
   *
   * Both streams go through one `runFor`, so a retry or a failover moves the
   * pair together. Two streams on two different models would give the trigger
   * two answers about native endpointing and give the Cost Meter two rates for
   * one session.
   */
  private async openTranscription(): Promise<void> {
    const settings = this.options.settings();
    const primary = this.resolveStt(settings.providers.stt.primary, settings, 'primary');
    const backup = this.resolveStt(settings.providers.stt.backup, settings, 'backup');

    if (!primary) {
      // Not a reason to refuse the session: the transcript, the timer and the
      // knowledge base all still work, and the user is told rather than left
      // with a session that silently never suggests anything (TC-132).
      this.options.onError(
        'transcription is unavailable: the speech-to-text model is not usable. ' +
          'The session is running, but nothing will be transcribed.',
      );
      return;
    }

    try {
      await this.options.health.runFor('stt', async (target) => {
        await this.openPair(this.targetFor(target, primary, backup, 'speech-to-text'));
      });
    } catch (err) {
      // Every retry and the failover have already been spent by the health
      // machine, which owns the Dashboard badge. Nothing reaches the overlay.
      this.options.onError('the speech-to-text provider could not be reached', err);
      return;
    }

    this.sttChoice = this.streams.get('interviewer')?.choice ?? null;
    this.options.onSttChoice(this.sttChoice);
  }

  /**
   * The target the health machine asked for, or a typed refusal (ADR-036).
   *
   * The machine's binding says a backup exists; whether that backup is
   * **usable** is this loop's question, and it can answer no (no key, not in
   * the registry, no adapter). Falling back to the primary there ran the
   * provider that had just failed while the machine recorded `using-backup`, so
   * the Dashboard named a backup that never answered a request. Refusing is the
   * truthful answer: the backup attempt failed, and it failed because there is
   * no usable backup.
   */
  private targetFor<T extends { choice: ProviderChoice }>(
    target: 'primary' | 'backup',
    primary: T,
    backup: T | null,
    what: string,
  ): T {
    if (target !== 'backup') return primary;
    if (backup) return backup;
    throw providerError(
      primary.choice.providerId,
      'client',
      `The configured ${what} backup cannot be used, so there is nothing to fail over to.`,
    );
  }

  /**
   * A stream reported a terminal failure, after its adapter's own reconnect
   * ladder (ADR-036).
   *
   * A streaming adapter's `open` resolves once it has asked its socket to
   * connect, so a refused, revoked or dropped connection surfaces here rather
   * than out of `openPair`. Without this the health machine never learned that
   * the provider had failed: `runFor` had already recorded the open as a
   * success, so no retry and no failover ever ran and the session transcribed
   * nothing for the rest of the interview.
   *
   * The failure is raised **into** the machine so its policy decides what
   * happens next, and the pair is re-opened on whatever it then serves.
   */
  private noteStreamFailure(cause: unknown): void {
    if (!this.isRunning || this.reopening) return;
    this.reopening = this.reopenAfterFailure(cause).finally(() => {
      this.reopening = null;
    });
  }

  private async reopenAfterFailure(cause: unknown): Promise<void> {
    const settings = this.options.settings();
    const primary = this.resolveStt(settings.providers.stt.primary, settings, 'primary');
    const backup = this.resolveStt(settings.providers.stt.backup, settings, 'backup');
    if (!primary) return;

    await this.closeStreams();

    let raised = false;
    try {
      await this.options.health.runFor('stt', async (target) => {
        // The socket died outside any `runFor` call, so the machine has not
        // seen the failure yet. The first attempt re-raises it rather than
        // opening a socket the provider has just refused; every attempt after
        // that is a real re-open, on whichever target the machine's own policy
        // has moved to (ADR-010).
        if (!raised) {
          raised = true;
          throw cause;
        }
        if (!this.isRunning) return;
        await this.openPair(this.targetFor(target, primary, backup, 'speech-to-text'));
      });
    } catch (err) {
      this.options.onError('transcription could not be restored for this session', err);
      return;
    }

    this.sttChoice = this.streams.get('interviewer')?.choice ?? null;
    this.options.onSttChoice(this.sttChoice);
  }

  /**
   * Open both streams on one target, leaving nothing half-open.
   *
   * A partially opened pair would put the session in a state where one stream
   * transcribes and the other silently does not, which reads as a provider that
   * cannot hear the candidate rather than as the failure it is.
   */
  private async openPair(target: SttTarget): Promise<void> {
    await this.closeStreams();
    try {
      for (const source of SOURCES) {
        const session = await this.openStt(target.choice, source, target.key, {
          turnEndGapMs: target.turnEndGapMs,
        });
        this.wireStream(source, session, target);
      }
    } catch (err) {
      await this.closeStreams();
      throw err;
    }
  }

  private wireStream(source: TranscriptSource, session: SttSession, target: SttTarget): void {
    session.on('transcript', (event) => {
      this.handleTranscript(event);
    });

    // Only the interviewer's native turn end reaches the machine. A candidate
    // endpoint would evaluate the interviewer's pending turn and fire it early,
    // which is exactly the firing `FR-055` forbids from that stream.
    if (source === 'interviewer') {
      session.on('endpoint', () => {
        this.options.trigger.handleEndpoint();
      });
    }

    // A streaming adapter's `open` resolves as soon as it has asked its socket
    // to connect; a refused or revoked connection is reported here, after the
    // adapter's own reconnect ladder has been spent. Logging it was not enough:
    // the health machine never saw the failure, so a dead primary never failed
    // over and the session simply transcribed nothing for the rest of the
    // interview (ADR-036).
    session.on('error', (err) => {
      this.options.onError(`the ${source} transcription stream failed`, err);
      this.noteStreamFailure(err);
    });

    this.streams.set(source, {
      session,
      choice: target.choice,
      sampleRate: target.sampleRate,
    });
  }

  /**
   * One normalized transcript event (`CH-206`).
   *
   * The append is issued **before** the trigger is told, because the Session
   * Manager stamps `seq` at call time: issuing it first is what guarantees the
   * question is recorded ahead of the suggestion it causes, whatever the two
   * writes then do on disk (`FR-101`, `FR-106`).
   */
  private handleTranscript(event: TranscriptEvent): void {
    // A provider can emit after its socket was closed, and a closed stream is
    // no longer in the map. Routing that event would push a live transcript
    // line to a Dashboard whose session has ended and would attempt an append
    // the writer has to refuse. Teardown order is this loop's to hold, not the
    // writer's to catch.
    if (!this.streams.has(event.source)) return;

    this.options.onTranscript(event);

    if (event.isFinal && event.text.trim() !== '') {
      void this.options.sessions
        .appendTurn(event.source, event.text.trim())
        .catch((err: unknown) => {
          // The entry is lost, and losing it quietly is the failure ADR-032
          // names. The overlay has no error state, so the log is where this is
          // made loud.
          this.options.onError('a transcript turn could not be appended', err);
        });
    }

    this.options.trigger.handleTranscript(event);
  }

  /* ---------------------------------------------------------------- *
   * Turn to suggestion (section 5.2)
   * ---------------------------------------------------------------- */

  /**
   * A turn passed the guard. Chain it behind its predecessor and answer it.
   *
   * Handed to `TriggerMachine.onFire`, which is synchronous, so the work is
   * started and the promise is kept rather than awaited here.
   */
  readonly onFire = (turn: TurnFired): void => {
    const previous = this.generation;
    // The catch is on the stored promise, not inside `runTurn`, so the chain a
    // later turn awaits can never reject. Nothing awaits this promise between
    // one turn and the next, so a rejection here would be an unhandled one, and
    // `NFR-009` would log it only after it had already escaped.
    this.generation = this.runTurn(turn, previous).catch((err: unknown) => {
      this.options.onError('the turn could not be answered', err);
    });
  };

  readonly classify = (text: string, signal: AbortSignal): Promise<ActionabilityVerdict> => {
    const operation = this.runClassification(text, signal);
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    );
    const previous = this.classification;
    const aggregate = Promise.all([previous, tracked]).then(() => undefined);
    this.classification = aggregate;
    void aggregate.finally(() => {
      if (this.classification === aggregate) this.classification = null;
    });
    return operation;
  };

  private async runClassification(
    text: string,
    parentSignal: AbortSignal,
  ): Promise<ActionabilityVerdict> {
    const settings = this.options.settings();
    const primary = this.resolveLlm(settings.providers.llm.primary, 'primary');
    if (!primary || this.options.health.for('llm').current.kind !== 'using-primary') {
      return 'actionable';
    }

    this.classificationCounter += 1;
    const classificationId = `classification-${String(Date.now())}-${String(this.classificationCounter)}`;
    let usage = { inputTokens: 0, outputTokens: 0 };
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    let rejectTimeout: ((reason: Error) => void) | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      abort();
      rejectTimeout?.(new Error('classification timed out'));
    }, CLASSIFICATION_TIMEOUT_MS);
    try {
      return await Promise.race([
        classifyWithLlm(
          text,
          classificationId,
          primary.choice,
          primary.provider,
          controller.signal,
          (reported) => {
            usage = reported;
          },
        ),
        timedOut,
      ]);
    } catch {
      return 'actionable';
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', abort);
      this.options.cost.noteGeneration(`classify:${classificationId}`, primary.choice, usage);
    }
  }

  private async runTurn(turn: TurnFired, previous: Promise<void> | null): Promise<void> {
    // The trigger aborted the predecessor before firing this turn. Awaiting it
    // here is what puts the cancelled generation's entry, carrying the bullets
    // already flushed, on disk **before** this one's (`FR-106`, TC-134).
    if (previous) await previous;

    const profileId = this.profileId;
    if (profileId === null || turn.signal.aborted) {
      this.options.trigger.noteGenerationSettled(turn.generationId);
      return;
    }

    let chunks: RetrievedChunk[];
    try {
      chunks = await this.options.retrieve(profileId, turn.question, RETRIEVAL_K);
    } catch (err) {
      // The turn is abandoned rather than answered from no notes. A suggestion
      // built without the knowledge base is indistinguishable, on the overlay,
      // from one built with it, and presenting it would be the plausible value
      // ADR-032 forbids. An unanswered turn looks like silence, which `FR-102`
      // says is not an error.
      this.options.onError('retrieval failed, so this turn is not answered', err);
      this.options.trigger.noteGenerationSettled(turn.generationId);
      return;
    }

    await this.generateFor(turn, chunks);
    this.options.trigger.noteGenerationSettled(turn.generationId);
  }

  private async generateFor(turn: TurnFired, chunks: RetrievedChunk[]): Promise<void> {
    const settings = this.options.settings();
    const primary = this.resolveLlm(settings.providers.llm.primary, 'primary');
    const backup = this.resolveLlm(settings.providers.llm.backup, 'backup');

    if (!primary) {
      this.options.onError('no usable language model is configured, so this turn is not answered');
      return;
    }

    // Held outside the closure because the health machine retries and fails
    // over: what the overlay was shown, and what the transcript must record, is
    // whatever the **last** attempt produced.
    const settled: { outcome: GenerationOutcome | null; choice: ProviderChoice } = {
      outcome: null,
      choice: primary.choice,
    };
    let attempt = 0;
    let stale = false;
    let firstLineChecked = false;
    let staleEndSent = false;
    /**
     * Whether a card for this generation is on the overlay right now.
     *
     * Not "has a begin ever been sent": an attempt that fails before producing
     * a bullet resolves `'cancelled'`, and `reduceCards` removes a cancelled
     * card outright (`ADR-047`), so the retry has to send its own `begin` or
     * its lines arrive for a card that no longer exists.
     */
    let cardUp = false;
    /**
     * Whether any attempt of this generation has put a bullet on the overlay.
     *
     * An attempt that fails before producing a bullet reports `'cancelled'`,
     * which says only that *it* salvaged nothing. After an earlier attempt's
     * salvage is on screen, forwarding that end would make `reduceCards` remove
     * the card and the salvage with it (FR-004, ADR-036, ADR-047).
     */
    let linesShown = false;

    try {
      await this.options.health.runFor('llm', async (target) => {
        const bound = this.targetFor(target, primary, backup, 'language model');
        settled.choice = bound.choice;

        const outcome = await this.generate(
          bound.provider,
          {
            generationId: turn.generationId,
            question: turn.question,
            candidateContext: turn.candidateContext,
            chunks,
            choice: bound.choice,
            systemPrompt: this.systemPrompt ?? undefined,
          },
          turn.signal,
          {
            onBegin: (payload) => {
              // This callback runs once per **attempt**, not once per
              // generation: `runFor` re-enters the closure on each retry and on
              // a failover (`health.ts` `runPrimaryWithLadder`, `runOnBackup`,
              // `runDegraded`), and `runGeneration` calls `onBegin` at the top
              // of every one. What it does here turns on whether a card is
              // still on the overlay.
              //
              // Card still up: the retry's begin is a duplicate, so it is
              // dropped and checkpoint 1 is not re-run. Re-running the clock
              // stranded a card once -- a retry past the threshold marked the
              // whole generation stale, which suppressed the real `onEnd` while
              // the cancellation that clears a card lives in `onLine` alone.
              // An already-begun generation is checkpoint 2's to catch.
              //
              // Card gone, because an empty failed attempt resolved
              // `'cancelled'` and `reduceCards` removed it: this begin is the
              // one that puts the retry's answer back on screen, so it is a
              // first begin in every sense and checkpoint 1 applies to it.
              if (cardUp) return;
              if (Date.now() - turn.firedAt > STALE_DISCARD_MS) {
                stale = true;
                return;
              }
              cardUp = true;
              this.options.onSuggestion({ channel: 'suggestion:begin', payload });
            },
            onLine: (payload) => {
              if (stale) return;
              if (!firstLineChecked) {
                firstLineChecked = true;
                if (Date.now() - turn.firedAt > STALE_DISCARD_MS) {
                  stale = true;
                  if (cardUp) {
                    cardUp = false;
                    staleEndSent = true;
                    this.options.onSuggestion({
                      channel: 'suggestion:end',
                      payload: { generationId: turn.generationId, status: 'cancelled' },
                    });
                  }
                  return;
                }
              }
              linesShown = true;
              this.options.onSuggestion({ channel: 'suggestion:line', payload });
            },
            onEnd: (payload) => {
              if (stale || staleEndSent) return;
              if (payload.status === 'cancelled') {
                // A failed attempt with nothing of its own to show must not
                // clear an earlier attempt's salvage. A newer turn's
                // cancellation still clears it, because FR-054 removes that
                // partial output.
                if (linesShown && !turn.signal.aborted) return;
                // `reduceCards` removes a cancelled card, so this end is what
                // leaves the overlay empty and what a retry's own begin has to
                // fill again.
                cardUp = false;
              }
              this.options.onSuggestion({ channel: 'suggestion:end', payload });
            },
          },
        );
        settled.outcome = outcome;

        // Accounted per **attempt**, under a key of its own. `noteGeneration`
        // replaces by id, which is right for one request reporting usage twice
        // (ADR-033) and wrong across a retry or a failover: both requests are
        // billable, possibly at different rates, and keying them alike would
        // drop everything the earlier attempts cost.
        attempt += 1;
        this.options.cost.noteGeneration(
          `${turn.generationId}#${String(attempt)}`,
          bound.choice,
          outcome.usage,
        );

        // `runGeneration` returns a provider failure rather than throwing it,
        // because the overlay has no error state (`FR-076`). The health machine
        // still has to see it or a dead key would never fail over, so it is
        // rethrown here and the salvaged outcome is kept above (`FR-100`).
        if (outcome.error) throw outcome.error;
        return outcome;
      });
    } catch (err) {
      this.options.onError('the language model failed', err);
    }

    const outcome = settled.outcome;
    if (!outcome) return;

    // Appended before the meter is told, and awaited, so the next turn's
    // generation (which awaits this promise) cannot append ahead of it.
    try {
      await this.options.sessions.appendSuggestion({
        forQuestion: turn.question,
        bullets: outcome.bullets,
        model: settled.choice.modelId,
        providerId: settled.choice.providerId,
        status: stale ? 'stale' : outcome.status,
      });
    } catch (err) {
      this.options.onError('a suggestion could not be appended to the transcript', err);
    }
  }

  /* ---------------------------------------------------------------- *
   * Resolution and teardown
   * ---------------------------------------------------------------- */

  /**
   * A transcription target, or null when it cannot be used.
   *
   * Resolved **outside** the health machine on purpose. A model that is not in
   * the registry and a credential with no key are configuration faults, not
   * provider failures, and routing them through `runFor` would classify them as
   * a non-retryable `client` error and take a perfectly good key to
   * `CONFIG_REQUIRED` (ADR-024).
   */
  private resolveStt(
    choice: ProviderChoice | null,
    settings: Settings,
    role: 'primary' | 'backup',
  ): SttTarget | null {
    if (!choice) return null;

    const model = findSttModel(choice);
    if (!model) {
      this.options.onError(
        `the ${role} speech-to-text model is not in the registry, so it cannot be opened`,
        { modelId: choice.modelId },
      );
      return null;
    }

    const key = this.options.keyFor(choice.providerId);
    if (key === undefined) {
      this.options.onInfo?.(`no key is saved for the ${role} speech-to-text provider`);
      return null;
    }

    return {
      choice,
      key,
      sampleRate: model.audio.sampleRate,
      // The user's gap, handed to whichever parameter the provider uses for it.
      // Never a constant in an adapter (`FR-050`, TC-159).
      turnEndGapMs: settings.trigger.turnEndGapMs,
    };
  }

  /** A language model target, or null. Resolved outside `runFor`, as above. */
  private resolveLlm(choice: ProviderChoice | null, role: 'primary' | 'backup'): LlmTarget | null {
    if (!choice) return null;
    try {
      return { choice, provider: this.resolveLlmProvider(choice) };
    } catch (err) {
      this.options.onError(`the ${role} language model is not usable`, err);
      return null;
    }
  }

  /** Wait for the generation in flight, whatever its outcome. */
  private async settleGeneration(): Promise<void> {
    const generation = this.generation;
    if (!generation) return;
    this.generation = null;
    try {
      await generation;
    } catch (err) {
      this.options.onError('the in-flight generation failed while stopping', err);
    }
  }

  private async settleClassification(): Promise<void> {
    const classification = this.classification;
    if (!classification) return;
    try {
      await classification;
    } catch (err) {
      this.options.onError('the in-flight classification failed while stopping', err);
    }
  }

  /**
   * Close every open stream, and stay routable until each one has finished.
   *
   * The map is cleared **after** the closes resolve, not before (ADR-036). A
   * batch adapter posts its remaining buffer inside `close` and answers with the
   * last thing the interviewer said; clearing first made `handleTranscript`
   * drop exactly that segment, so every session recorded with a batch model lost
   * its final turn. `closing` is what keeps a *chunk* out of a socket that is
   * going away, which is the other thing the early clear was doing.
   *
   * A close that throws is reported and the rest still close.
   */
  private async closeStreams(): Promise<void> {
    const open = [...this.streams.entries()];
    if (open.length === 0) return;
    this.closing = true;

    await Promise.all(
      open.map(async ([source, stream]) => {
        try {
          await stream.session.close();
        } catch (err) {
          this.options.onError(`the ${source} transcription stream did not close cleanly`, err);
        }
      }),
    );

    this.streams.clear();
    this.sttChoice = null;
    this.closing = false;
  }
}
