/**
 * Provider health and failover (`CMP-12`). Mirrors `docs/02-architecture.md`
 * section 3.5 (ADR-009, ADR-010, ADR-017, ADR-024).
 *
 * Health is keyed by **credential**, not by capability. One key can serve a
 * realtime transcription socket, a batch endpoint and a chat model at once, so
 * a revoked key is one fact about one credential, not three separate failures. That is why there
 * is one state machine and one probe timer per credential, and why the
 * Dashboard shows one badge naming every affected capability (TC-143).
 */
import type { CredentialId, ErrorClass, HealthState, ProviderError } from '../../shared/types.js';

export const RETRY_BACKOFF_MS = [250, 500, 1000];
export const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_MS.length;
export const JITTER_FRACTION = 0.2;

/** `DEGRADED` keeps retrying forever, so its backoff has to stop growing. */
export const DEGRADED_MAX_BACKOFF_MS = 10_000;

export const PROBE_INTERVAL_MS = 60_000;
/** Two consecutive passes, so one lucky probe does not move a live session. */
export const PROBE_PASSES_TO_RECOVER = 2;

export type Target = 'primary' | 'backup';

export interface HealthDeps {
  /** Injected so tests drive the ladder without waiting on real time. */
  sleep(ms: number): Promise<void>;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Jitter source. Returns 0..1. */
  random(): number;
}

const REAL_DEPS: HealthDeps = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
  random: () => Math.random(),
};

/** Applies up to +/- JITTER_FRACTION so a fleet does not retry in lockstep. */
export function jittered(baseMs: number, random: number): number {
  const spread = baseMs * JITTER_FRACTION;
  return Math.round(baseMs - spread + random * spread * 2);
}

export function withinJitterBounds(baseMs: number, actualMs: number): boolean {
  const spread = baseMs * JITTER_FRACTION;
  return actualMs >= Math.floor(baseMs - spread) && actualMs <= Math.ceil(baseMs + spread);
}

export interface CredentialHealthOptions {
  credentialId: CredentialId;
  /** Whether a backup using a *different* credential is configured (FR-025). */
  hasBackup: boolean;
  /** Probes the primary. Resolves true if it answered. */
  probe: () => Promise<boolean>;
  onChange: (state: HealthState) => void;
  deps?: Partial<HealthDeps>;
}

/**
 * Thrown by `run` when the credential is in `CONFIG_REQUIRED`. It carries no
 * request, because the point of that state is that no request is sent.
 */
export class CredentialUnusableError extends Error {
  constructor(
    readonly credentialId: CredentialId,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'CredentialUnusableError';
  }
}

export class CredentialHealth {
  readonly credentialId: CredentialId;

  private state: HealthState = { kind: 'using-primary' };
  private readonly hasBackup: boolean;
  private hasBackupForThisRun = false;
  private readonly probeFn: () => Promise<boolean>;
  private readonly emit: (s: HealthState) => void;
  private readonly deps: HealthDeps;

  private probeHandle: unknown = null;
  private consecutivePasses = 0;
  private probeInFlight = false;

  /** Set when probes have passed twice. The switch waits for a clean boundary. */
  private switchBackPending = false;

  /** Grows while DEGRADED, capped. Reset by any success. */
  private degradedAttempt = 0;

  /** Every backoff this credential has actually slept, for TC-100. */
  readonly backoffsMs: number[] = [];

  constructor(options: CredentialHealthOptions) {
    this.credentialId = options.credentialId;
    this.hasBackup = options.hasBackup;
    this.probeFn = options.probe;
    this.emit = options.onChange;
    this.deps = { ...REAL_DEPS, ...options.deps };
  }

  get current(): HealthState {
    return this.state;
  }

  get target(): Target {
    return this.state.kind === 'using-backup' ? 'backup' : 'primary';
  }

  get isTerminal(): boolean {
    return this.state.kind === 'config-required';
  }

  get hasPendingSwitchBack(): boolean {
    return this.switchBackPending;
  }

  /**
   * Runs one request under the health policy.
   *
   * `fn` is called with the target to use, so the caller does not decide where
   * the request goes. Every transition is emitted, so `CH-202` reflects the
   * machine rather than a periodic snapshot.
   */
  async run<T>(
    fn: (target: Target) => Promise<T>,
    options: { hasBackup?: boolean } = {},
  ): Promise<T> {
    // Whether a backup exists is a property of the *capability binding*, not of
    // the credential: one OpenAI key can be the LLM primary with no backup and
    // the STT backup at the same time. So the caller supplies it per request
    // and the machine keeps only the credential-level facts.
    this.hasBackupForThisRun = options.hasBackup ?? this.hasBackup;

    if (this.state.kind === 'config-required') {
      // Terminal for the session. A revoked key must not fire a doomed request
      // every ten seconds for a whole interview (ADR-024).
      throw new CredentialUnusableError(this.credentialId, this.state.reason);
    }

    // On the backup, or already degraded, there is no ladder left to climb:
    // one attempt, and a failure re-enters the same state with more backoff.
    if (this.state.kind === 'using-backup') return this.runOnBackup(fn);
    if (this.state.kind === 'degraded') return this.runDegraded(fn);

    return this.runPrimaryWithLadder(fn);
  }

  private async runPrimaryWithLadder<T>(fn: (t: Target) => Promise<T>): Promise<T> {
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const result = await fn('primary');
        this.setState({ kind: 'using-primary' });
        this.degradedAttempt = 0;
        return result;
      } catch (err) {
        const error = asProviderError(err, this.credentialId);
        lastError = error;

        // An auth or client error will fail identically on every attempt, so
        // the ladder is skipped entirely (ADR-010, TC-101).
        if (!error.retryable) break;
        if (attempt === MAX_RETRY_ATTEMPTS) break;

        this.setState({ kind: 'retrying', attempt: attempt + 1 });
        await this.backoff(RETRY_BACKOFF_MS[attempt] ?? DEGRADED_MAX_BACKOFF_MS);
      }
    }

    const error = lastError ?? unknownError(this.credentialId);
    return this.failOver(error, fn);
  }

  private async failOver<T>(error: ProviderError, fn: (t: Target) => Promise<T>): Promise<T> {
    if (this.hasBackupForThisRun) {
      this.setState({ kind: 'using-backup' });
      this.startProbing();
      return this.runOnBackup(fn);
    }

    // No backup. The path splits on `retryable` (ADR-024).
    if (error.retryable) {
      this.setState({ kind: 'degraded', reason: error.message });
      return this.runDegraded(fn);
    }

    this.setState({
      kind: 'config-required',
      credentialId: this.credentialId,
      reason: error.message,
    });
    this.stopProbing();
    throw new CredentialUnusableError(this.credentialId, error.message);
  }

  private async runOnBackup<T>(fn: (t: Target) => Promise<T>): Promise<T> {
    // Sticky: a failure on the backup does not walk back to the primary, which
    // is the provider that just failed three times.
    return fn('backup');
  }

  private async runDegraded<T>(fn: (t: Target) => Promise<T>): Promise<T> {
    try {
      const result = await fn('primary');
      this.degradedAttempt = 0;
      this.setState({ kind: 'using-primary' });
      return result;
    } catch (err) {
      const error = asProviderError(err, this.credentialId);
      if (!error.retryable) {
        this.setState({
          kind: 'config-required',
          credentialId: this.credentialId,
          reason: error.message,
        });
        throw new CredentialUnusableError(this.credentialId, error.message);
      }
      this.degradedAttempt += 1;
      this.setState({ kind: 'degraded', reason: error.message });
      await this.backoff(this.degradedBackoffMs());
      throw error;
    }
  }

  /** Doubles from the last rung of the ladder, capped so it stops growing. */
  degradedBackoffMs(): number {
    const base = (RETRY_BACKOFF_MS.at(-1) ?? 1000) * 2 ** (this.degradedAttempt - 1);
    return Math.min(base, DEGRADED_MAX_BACKOFF_MS);
  }

  private async backoff(baseMs: number): Promise<void> {
    const ms = jittered(baseMs, this.deps.random());
    this.backoffsMs.push(ms);
    await this.deps.sleep(ms);
  }

  private startProbing(): void {
    if (this.probeHandle !== null) return;
    this.consecutivePasses = 0;
    this.probeHandle = this.deps.setInterval(() => {
      void this.runProbe();
    }, PROBE_INTERVAL_MS);
  }

  private stopProbing(): void {
    if (this.probeHandle === null) return;
    this.deps.clearInterval(this.probeHandle);
    this.probeHandle = null;
    this.consecutivePasses = 0;
  }

  /** Exposed for tests; in production the interval calls it. */
  async runProbe(): Promise<void> {
    if (this.probeInFlight) return;
    this.probeInFlight = true;
    try {
      const passed = await this.probeFn();
      this.consecutivePasses = passed ? this.consecutivePasses + 1 : 0;
      if (this.consecutivePasses >= PROBE_PASSES_TO_RECOVER) {
        // Do not switch here. The switch lands on a clean boundary, because an
        // STT provider change mid-utterance loses the words in flight (TC-144).
        this.switchBackPending = true;
      }
    } catch {
      this.consecutivePasses = 0;
    } finally {
      this.probeInFlight = false;
    }
  }

  /**
   * Called by the session manager at a clean boundary: the next turn for the
   * LLM, and for STT the next turn boundary with no audio in flight. This is
   * the only place a switch back to the primary happens.
   */
  noteCleanBoundary(): boolean {
    if (!this.switchBackPending) return false;
    this.switchBackPending = false;
    this.stopProbing();
    this.degradedAttempt = 0;
    this.setState({ kind: 'using-primary' });
    return true;
  }

  /**
   * The user saved a new key for this credential and it passed live validation
   * (FR-026). That is the only thing that clears `CONFIG_REQUIRED`.
   */
  noteKeySaved(): void {
    this.state = { kind: 'using-primary' };
    this.switchBackPending = false;
    this.degradedAttempt = 0;
    this.stopProbing();
    this.setState({ kind: 'using-primary' });
  }

  dispose(): void {
    this.stopProbing();
  }

  private setState(next: HealthState): void {
    // `config-required` is terminal for the credential, not for one capability.
    // A revoked key stays revoked even where another capability routes around
    // it, so nothing but `noteKeySaved` moves the machine out of that state.
    if (this.state.kind === 'config-required' && next.kind !== 'config-required') return;
    if (sameState(this.state, next)) return;
    this.state = next;
    this.emit(next);
  }
}

function sameState(a: HealthState, b: HealthState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'retrying' && b.kind === 'retrying') return a.attempt === b.attempt;
  if (a.kind === 'degraded' && b.kind === 'degraded') return a.reason === b.reason;
  if (a.kind === 'config-required' && b.kind === 'config-required') return a.reason === b.reason;
  return true;
}

function asProviderError(err: unknown, credentialId: string): ProviderError {
  if (err instanceof Error && 'class' in err && 'retryable' in err) {
    return err as ProviderError;
  }
  return unknownError(credentialId, err instanceof Error ? err.message : String(err));
}

function unknownError(credentialId: string, message = 'The provider failed.'): ProviderError {
  const error = new Error(message) as ProviderError;
  // An unrecognized failure is treated as retryable. Ending an interview on an
  // error we could not classify is worse than one more attempt.
  error.class = 'network' satisfies ErrorClass;
  error.providerId = credentialId;
  error.retryable = true;
  return error;
}

/** Worst-wins ordering when one capability depends on several credentials. */
const SEVERITY: Record<HealthState['kind'], number> = {
  'using-primary': 0,
  retrying: 1,
  'using-backup': 2,
  degraded: 3,
  'config-required': 4,
};

/** A capability and the credential currently serving it. */
export interface CapabilityBinding {
  capability: 'stt' | 'llm';
  primary: CredentialId;
  backup: CredentialId | null;
}

export interface ProvidersState {
  stt: HealthState;
  llm: HealthState;
}

/**
 * Owns one `CredentialHealth` per credential in use, and projects them onto the
 * capability-shaped `CH-202` payload.
 *
 * The projection is the answer to a shape mismatch the architecture leaves
 * implicit: the state machine is keyed by credential, `CH-202` is keyed by
 * capability. A capability reports the health of whichever credential is
 * serving it, so one rejected OpenAI key shows the same `config-required`
 * state, naming the same `credentialId`, under both `stt` and `llm`. The
 * Dashboard groups by `credentialId` and renders one badge naming both
 * capabilities, rather than two badges saying the same thing (TC-143).
 */
export class ProviderHealthRegistry {
  private readonly byCredential = new Map<CredentialId, CredentialHealth>();
  private readonly bindings = new Map<'stt' | 'llm', CapabilityBinding>();

  constructor(
    private readonly onChange: (state: ProvidersState) => void,
    private readonly makeProbe: (credentialId: CredentialId) => () => Promise<boolean>,
    private readonly deps?: Partial<HealthDeps>,
  ) {}

  bind(binding: CapabilityBinding): void {
    this.bindings.set(binding.capability, binding);
    this.ensure(binding.primary, binding.backup !== null);
    // The backup gets a machine too. A revoked backup key is a fact the user
    // needs before the primary fails, not after (TC-143).
    if (binding.backup !== null) this.ensure(binding.backup, false);
  }

  /** One machine per credential, however many capabilities it serves (ADR-017). */
  private ensure(credentialId: CredentialId, hasBackup: boolean): CredentialHealth {
    const existing = this.byCredential.get(credentialId);
    if (existing) return existing;

    const health = new CredentialHealth({
      credentialId,
      hasBackup,
      probe: this.makeProbe(credentialId),
      onChange: () => {
        this.onChange(this.snapshot());
      },
      deps: this.deps,
    });
    this.byCredential.set(credentialId, health);
    return health;
  }

  for(capability: 'stt' | 'llm'): CredentialHealth {
    const binding = this.bindings.get(capability);
    if (!binding) throw new Error(`No credential is bound to "${capability}".`);
    return this.ensure(binding.primary, binding.backup !== null);
  }

  /**
   * Runs a request for one capability, telling the machine whether *this*
   * capability has a backup to fall to. Two capabilities sharing a credential
   * can disagree about that, so it cannot live on the machine.
   */
  runFor<T>(capability: 'stt' | 'llm', fn: (target: Target) => Promise<T>): Promise<T> {
    const binding = this.bindings.get(capability);
    if (!binding) throw new Error(`No credential is bound to "${capability}".`);
    return this.ensure(binding.primary, binding.backup !== null).run(fn, {
      hasBackup: binding.backup !== null,
    });
  }

  get(credentialId: CredentialId): CredentialHealth | null {
    return this.byCredential.get(credentialId) ?? null;
  }

  /** How many probe timers are live. One per credential, never one per capability. */
  get credentialCount(): number {
    return this.byCredential.size;
  }

  /** Every capability the given credential serves, for the single badge. */
  capabilitiesFor(credentialId: CredentialId): ('stt' | 'llm')[] {
    return [...this.bindings.values()]
      .filter((b) => b.primary === credentialId || b.backup === credentialId)
      .map((b) => b.capability);
  }

  snapshot(): ProvidersState {
    return {
      stt: this.stateOf('stt'),
      llm: this.stateOf('llm'),
    };
  }

  /**
   * A capability reports the worst state among every credential it depends on,
   * its backup included.
   *
   * `TC-143` is the reason. There OpenAI is the STT *backup* and the LLM
   * primary, so reading the primary alone would leave STT looking healthy while
   * the key it would fail over to is revoked. Both capabilities now report the
   * same `config-required` naming the same `credentialId`, and the Dashboard
   * groups by that id to render one badge naming both.
   */
  private stateOf(capability: 'stt' | 'llm'): HealthState {
    const binding = this.bindings.get(capability);
    if (!binding) return { kind: 'using-primary' };

    const states = [binding.primary, binding.backup]
      .filter((id): id is CredentialId => id !== null)
      .map((id) => this.byCredential.get(id)?.current)
      .filter((s): s is HealthState => s !== undefined);

    return states.reduce<HealthState>(
      (worst, s) => (SEVERITY[s.kind] > SEVERITY[worst.kind] ? s : worst),
      { kind: 'using-primary' },
    );
  }

  /** The user saved a key. Clears CONFIG_REQUIRED for that credential only. */
  noteKeySaved(credentialId: CredentialId): void {
    this.byCredential.get(credentialId)?.noteKeySaved();
  }

  /**
   * A clean boundary reached. Returns the credentials that switched back.
   *
   * For STT a boundary is clean only when no audio is in flight: switching
   * providers with chunks still unacknowledged closes the socket mid-utterance
   * and loses the words in it. That is passed in and checked here rather than
   * left to the caller to remember, so `TC-144` is enforced rather than
   * documented.
   */
  noteCleanBoundary(options: { audioInFlight?: number } = {}): CredentialId[] {
    if ((options.audioInFlight ?? 0) > 0) return [];
    const switched: CredentialId[] = [];
    for (const [id, health] of this.byCredential) {
      if (health.noteCleanBoundary()) switched.push(id);
    }
    return switched;
  }

  dispose(): void {
    for (const health of this.byCredential.values()) health.dispose();
    this.byCredential.clear();
    this.bindings.clear();
  }
}
