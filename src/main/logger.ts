import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The logger, and the single place secrets are redacted (FR-034, NFR-003).
 *
 * Redaction lives here and in the error serializer below, and nowhere else. In
 * particular the IPC router does not redact: a key leaked from a path that never
 * crosses IPC, such as a provider health probe, must still be masked, so the
 * mask has to sit at the sink rather than at one crossing point (TC-139).
 */

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Patterns for the API key shapes this app handles. Deliberately broad: a false
 * positive costs a masked log line, a false negative leaks a credential.
 */
const KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bTokenc?[A-Za-z0-9_-]{24,}/g, // Deepgram "Token <key>" header form
  /\b[a-f0-9]{40}\b/g, // Deepgram raw key
  /\bxi-api-key\s*[:=]\s*\S+/gi, // ElevenLabs header form
  /\bsk_[A-Za-z0-9]{32,}/g, // ElevenLabs
];

/** Keys whose value is masked wholesale regardless of shape. */
const SENSITIVE_FIELD = /(apikey|api_key|authorization|secret|token|password)/i;

const MASK = '[redacted]';

/**
 * Mask anything that looks like a credential. Applied to every log argument
 * and to every serialized Error (FR-034).
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const pattern of KEY_PATTERNS) out = out.replace(pattern, MASK);
    return out;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  // Walked key by key, binary data becomes one log field per byte, which puts
  // audio into main.log (NFR-002, docs/03-tasks.md Definition of Done). Only
  // its size is useful in a diagnostic.
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[binary ${String(value.byteLength)} bytes]`;
  }
  // These have no own enumerable keys, so the walk below would print `{}`.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof Map) return `[Map size ${String(value.size)}]`;
  if (value instanceof Set) return `[Set size ${String(value.size)}]`;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, seen),
      stack: typeof value.stack === 'string' ? (redact(value.stack, seen) as string) : undefined,
      ...(redact({ ...value }, seen) as Record<string, unknown>),
    };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_FIELD.test(k) && v !== undefined && v !== null ? MASK : redact(v, seen);
  }
  return out;
}

function stringify(value: unknown): string {
  const safe = redact(value);
  if (typeof safe === 'string') return safe;
  try {
    return JSON.stringify(safe);
  } catch {
    return String(safe);
  }
}

export interface LoggerOptions {
  /** Directory for main.log. Injected so tests never touch a real userData path. */
  dir: string;
  /** Mirror to the console. Off in tests. */
  console?: boolean;
}

/**
 * A size-rotating file logger. Rotates at 5 MB keeping 3 files (FR-035).
 */
export class Logger {
  private readonly dir: string;
  private readonly toConsole: boolean;
  /** Set after the first failed write, so the stderr notice is printed once. */
  private fileFailed = false;

  constructor(options: LoggerOptions) {
    this.dir = options.dir;
    this.toConsole = options.console ?? false;
    mkdirSync(this.dir, { recursive: true });
  }

  private get file(): string {
    return join(this.dir, 'main.log');
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.file)) return;
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;

    // main.log.2 -> main.log.3 (dropped), main.log.1 -> main.log.2, main.log -> main.log.1
    for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
      const from = join(this.dir, `main.log.${i}`);
      const to = join(this.dir, `main.log.${i + 1}`);
      if (!existsSync(from)) continue;
      if (i + 1 >= MAX_FILES) {
        unlinkSync(from);
        continue;
      }
      renameSync(from, to);
    }
    renameSync(this.file, join(this.dir, 'main.log.1'));
  }

  /**
   * Never throws (NFR-009). Callers log from catch blocks and from the global
   * fault handler, so a full disk or a Windows EBUSY on main.log used to throw
   * a second error out of the handler of the first. A rotation failure is
   * skipped and retried on the next line. A failed append sends the line to
   * stderr instead, with a one-time notice.
   */
  log(level: LogLevel, message: string, ...args: unknown[]): void {
    try {
      this.rotateIfNeeded();
    } catch {
      // The line still goes to the current file. Rotation is retried next time.
    }
    const parts = [new Date().toISOString(), level.toUpperCase(), stringify(message)];
    for (const a of args) parts.push(stringify(a));
    const line = `${parts.join(' ')}\n`;

    // Written synchronously on purpose. The log is the diagnostic record when
    // the app dies, so a line buffered in a stream and lost on a crash is worse
    // than the cost of the sync write at this volume (NFR-009).
    let written = true;
    try {
      appendFileSync(this.file, line, 'utf8');
    } catch (err) {
      written = false;
      if (!this.fileFailed) {
        this.fileFailed = true;
        const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
        writeQuietly(process.stderr, `main.log is not writable (${code}); logging to stderr\n`);
      }
    }
    if (this.toConsole) writeQuietly(process.stdout, line);
    else if (!written) writeQuietly(process.stderr, line);
  }

  debug(m: string, ...a: unknown[]): void {
    this.log('debug', m, ...a);
  }
  info(m: string, ...a: unknown[]): void {
    this.log('info', m, ...a);
  }
  warn(m: string, ...a: unknown[]): void {
    this.log('warn', m, ...a);
  }
  error(m: string, ...a: unknown[]): void {
    this.log('error', m, ...a);
  }

  /** No-op: writes are synchronous, so there is nothing buffered to flush. */
  close(): void {}
}

/** A console write that cannot throw, for example on a closed pipe (EPIPE). */
/** Streams that already have the listener below, so it is added once. */
const quietStreams = new WeakSet<NodeJS.WriteStream>();

function writeQuietly(stream: NodeJS.WriteStream, text: string): void {
  // A closed pipe reports EPIPE as an `error` event after `write()` returns,
  // and an `error` event with no listener ends the process. The catch below
  // only sees synchronous throws.
  if (!quietStreams.has(stream)) {
    quietStreams.add(stream);
    stream.on('error', () => undefined);
  }
  try {
    stream.write(text);
  } catch {
    // Nowhere is left to report it.
  }
}

let singleton: Logger | null = null;

/** Install the process-wide logger. Called once from the main entry point. */
export function initLogger(options: LoggerOptions): Logger {
  singleton = new Logger(options);
  return singleton;
}

export function getLogger(): Logger {
  if (!singleton) throw new Error('Logger not initialized. Call initLogger first.');
  return singleton;
}
