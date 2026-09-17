/**
 * The filesystem write monitor `NFR-002` and `ADR-019` call for (`TC-137`).
 *
 * `ADR-019` scopes the audio-on-disk guarantee to code this project controls and
 * verifies it two ways: a lint ban on filesystem imports along the audio path,
 * and this, a monitor that records every byte the process writes during a
 * synthetic session and asserts none of it is PCM. The lint rule cannot see a
 * dependency spooling a request body to a temp file. This can.
 *
 * The recorder is its own module because `vi.mock` factories are hoisted above
 * the test body and cannot close over a local. The test's mock factories import
 * this, wrap the real write entry points and push here.
 */

/** One write the monitor saw. `bytes` is a copy, so a reused buffer cannot lie. */
export interface RecordedWrite {
  /** The `fs` entry point, e.g. `appendFileSync` or `FileHandle.write`. */
  via: string;
  /** The destination, where the entry point names one. */
  target: string;
  bytes: Uint8Array;
}

/** Every write since {@link startRecording}. */
export const writes: RecordedWrite[] = [];

let recording = false;

export function startRecording(): void {
  writes.length = 0;
  recording = true;
}

export function stopRecording(): void {
  recording = false;
}

/** Normalize whatever an `fs` write was handed into bytes, or null if it is not data. */
function toBytes(data: unknown): Uint8Array | null {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return null;
}

/** Record one write. Called from the wrappers the test installs. */
export function record(via: string, target: unknown, data: unknown): void {
  if (!recording) return;
  const bytes = toBytes(data);
  if (!bytes) return;
  writes.push({ via, target: typeof target === 'string' ? target : String(target), bytes });
}

/**
 * The longest run of one repeated byte in `bytes`.
 *
 * The synthetic session fills every PCM chunk with a single sentinel byte, so a
 * long run of it is the signature of audio reaching disk, whether raw or inside
 * a WAV container. Counting the run rather than searching for a fixed needle
 * means a spool that wrote only part of a buffer is still caught.
 */
export function longestRunOf(bytes: Uint8Array, value: number): number {
  let best = 0;
  let run = 0;
  for (const byte of bytes) {
    run = byte === value ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Every recorded write holding a run of `value` at least `minRun` bytes long. */
export function writesContainingRun(value: number, minRun: number): RecordedWrite[] {
  return writes.filter((w) => longestRunOf(w.bytes, value) >= minRun);
}
