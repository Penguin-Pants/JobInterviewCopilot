/**
 * TASK-050, TC-137. `NFR-002` and `ADR-019`: no audio byte this project writes,
 * or causes to be written, reaches the filesystem.
 *
 * `ADR-019` scopes the guarantee to code this project controls and proves it two
 * ways. The ESLint ban on filesystem imports along the reachable audio path is
 * the static half and already holds. This is the dynamic half: every `fs` write
 * entry point is wrapped for the length of a synthetic session, every byte
 * written is recorded, and none of it may be PCM.
 *
 * The session runs with **Whisper active** on purpose. Whisper is the one
 * adapter that builds a request body out of audio, and a multipart body is
 * exactly the thing an HTTP client is tempted to spool to a temp file. If the
 * adapter ever handed over a path or a stream instead of the in-memory `Blob`
 * `ADR-019` requires, the spool would land in a write this monitor records.
 *
 * The app-owned temporary directory is checked at session end for the same
 * reason: a spool by something outside this process's `fs` calls still has to
 * land somewhere, and `useAppOwnedTempDir` makes that somewhere knowable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const monitor = await import('../fakes/fs-monitor.js');
  return {
    ...actual,
    default: actual,
    appendFileSync: (path: unknown, data: unknown, ...rest: unknown[]) => {
      monitor.record('appendFileSync', path, data);
      return (actual.appendFileSync as (...a: unknown[]) => void)(path, data, ...rest);
    },
    writeFileSync: (path: unknown, data: unknown, ...rest: unknown[]) => {
      monitor.record('writeFileSync', path, data);
      return (actual.writeFileSync as (...a: unknown[]) => void)(path, data, ...rest);
    },
    writeSync: (fd: unknown, data: unknown, ...rest: unknown[]) => {
      monitor.record('writeSync', fd, data);
      return (actual.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
    },
    createWriteStream: (path: unknown, ...rest: unknown[]) => {
      const stream = (
        actual.createWriteStream as (...a: unknown[]) => import('node:fs').WriteStream
      )(path, ...rest);
      const write = stream.write.bind(stream);
      stream.write = ((data: unknown, ...args: unknown[]) => {
        monitor.record('createWriteStream', path, data);
        return (write as (...a: unknown[]) => boolean)(data, ...args);
      }) as typeof stream.write;
      return stream;
    },
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const monitor = await import('../fakes/fs-monitor.js');
  return {
    ...actual,
    default: actual,
    writeFile: (path: unknown, data: unknown, ...rest: unknown[]) => {
      monitor.record('writeFile', path, data);
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, data, ...rest);
    },
    appendFile: (path: unknown, data: unknown, ...rest: unknown[]) => {
      monitor.record('appendFile', path, data);
      return (actual.appendFile as (...a: unknown[]) => Promise<void>)(path, data, ...rest);
    },
    // The Session Manager writes the transcript through a FileHandle, so the
    // handle's own write methods have to be wrapped too. Without this the
    // monitor would see no traffic at all and pass vacuously.
    open: async (path: unknown, ...rest: unknown[]) => {
      const handle = await (
        actual.open as (...a: unknown[]) => Promise<import('node:fs/promises').FileHandle>
      )(path, ...rest);
      for (const name of ['write', 'writeFile', 'appendFile'] as const) {
        const original = handle[name].bind(handle);
        (handle as unknown as Record<string, unknown>)[name] = (
          data: unknown,
          ...args: unknown[]
        ) => {
          monitor.record(`FileHandle.${name}`, path, data);
          return (original as (...a: unknown[]) => unknown)(data, ...args);
        };
      }
      return handle;
    },
  };
});

const { clearSttProviders } = await import('../../src/main/ai/stt.js');
const { createWhisperProvider, WHISPER_BUFFER_CHUNKS } =
  await import('../../src/main/ai/stt/whisper.js');
const { appOwnedTempEntries, useAppOwnedTempDir } = await import('../../src/main/resilience.js');
const { defaultSettings } = await import('../../src/shared/defaults.js');
const monitor = await import('../fakes/fs-monitor.js');
const { ONE_SECOND_BYTES, harness, startSession, stopSession } =
  await import('../fakes/live-harness.js');

/**
 * Every PCM byte of the synthetic session is this value, so a run of it in a
 * write is the signature of audio on disk, raw or inside a WAV container.
 * `0xa7` is not ASCII and does not occur in JSON, so a transcript line cannot
 * produce a false positive.
 */
const PCM_SENTINEL = 0xa7;

/** Shorter than one chunk, long enough that no encoding accident reaches it. */
const RUN_THRESHOLD = 64;

/** Whisper's registry entry, so the session buffers and posts real audio. */
function whisperSettings() {
  const base = defaultSettings();
  return {
    providers: {
      ...base.providers,
      stt: { primary: { providerId: 'openai', modelId: 'whisper-1' }, backup: null },
    },
  };
}

/** The variables `useAppOwnedTempDir` sets, saved so this process gets them back. */
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const;

let userData: string;
let savedTempVars: Record<string, string | undefined>;

beforeEach(() => {
  clearSttProviders();
  userData = mkdtempSync(join(tmpdir(), 'icp-audio-privacy-'));
  savedTempVars = Object.fromEntries(TEMP_VARS.map((name) => [name, process.env[name]]));
});

afterEach(() => {
  monitor.stopRecording();
  clearSttProviders();
  for (const name of TEMP_VARS) {
    if (savedTempVars[name] === undefined) delete process.env[name];
    else process.env[name] = savedTempVars[name];
  }
  rmSync(userData, { recursive: true, force: true });
});

describe('TC-137 no audio reaches the filesystem', () => {
  it('records every write of a Whisper session and none of them is PCM', async () => {
    // The real `process.env`, not a copy. Pointing this process's own
    // `os.tmpdir()` at the app-owned directory is what gives the assertion at
    // the end of this test teeth: a dependency that spools a request body the
    // ordinary way now lands somewhere this test looks. `afterEach` puts the
    // three variables back.
    const appTemp = useAppOwnedTempDir(userData);
    expect(appOwnedTempEntries(appTemp)).toEqual([]);
    expect(tmpdir()).toBe(appTemp);

    // The transport that would have posted to OpenAI. It keeps each body so the
    // "built in memory, never a path and never a stream" half of ADR-019 is
    // asserted rather than assumed.
    const bodies: FormData[] = [];
    const post = (body: FormData) => {
      bodies.push(body);
      return Promise.resolve({ ok: true, status: 200, text: 'a transcribed sentence' });
    };

    const h = harness(userData, {
      settings: whisperSettings(),
      sttAdapter: { provider: createWhisperProvider(post), transport: 'batch' },
    });
    h.health.bind({ capability: 'stt', primary: 'openai', backup: null });

    monitor.startRecording();
    await startSession(h);
    expect(h.live.openStreamCount).toBe(2);

    // Enough audio for two full Whisper windows on each stream, so the adapter
    // really encodes a WAV and really hands it to the transport.
    const chunks = WHISPER_BUFFER_CHUNKS * 2;
    for (let i = 1; i <= chunks; i += 1) {
      h.sendChunk('interviewer', i, PCM_SENTINEL);
      h.sendChunk('candidate', i, PCM_SENTINEL);
    }

    const session = await stopSession(h);
    monitor.stopRecording();

    /* -------------------------------------------------------------- *
     * The monitor saw real traffic
     * -------------------------------------------------------------- */

    // A monitor that recorded nothing proves nothing. The transcript alone is
    // several writes.
    expect(monitor.writes.length).toBeGreaterThan(0);
    expect(monitor.writes.some((w) => w.via.startsWith('FileHandle.'))).toBe(true);

    // And the audio really went somewhere: two windows per stream, four bodies.
    expect(bodies.length).toBeGreaterThanOrEqual(4);

    /* -------------------------------------------------------------- *
     * None of it was audio
     * -------------------------------------------------------------- */

    const offending = monitor.writesContainingRun(PCM_SENTINEL, RUN_THRESHOLD);
    expect(
      offending.map((w) => `${w.via} -> ${w.target}`),
      'a write containing PCM reached the filesystem',
    ).toEqual([]);

    // Belt and braces: not one recorded byte matches the sentinel at all. The
    // run check above is what catches a partial spool; this catches a single
    // stray byte and is only meaningful because the sentinel is not ASCII.
    expect(monitor.writes.some((w) => w.bytes.includes(PCM_SENTINEL))).toBe(false);

    /* -------------------------------------------------------------- *
     * The body was in memory, and the temp directory is empty
     * -------------------------------------------------------------- */

    for (const body of bodies) {
      const file = body.get('file');
      // A Blob, never a path and never a ReadStream (ADR-019).
      expect(file).toBeInstanceOf(Blob);
      expect(typeof file).not.toBe('string');
      expect((file as Blob).size).toBeGreaterThan(ONE_SECOND_BYTES);
    }

    expect(appOwnedTempEntries(appTemp)).toEqual([]);

    // The session itself still did its job, so none of the above passed because
    // nothing happened.
    expect(session).not.toBeNull();
    expect(session!.entries.filter((e) => e.kind === 'turn').length).toBeGreaterThan(0);
  });
});
