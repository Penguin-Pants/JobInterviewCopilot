/**
 * The PCM framing worklet (CMP-03b, FR-041, FR-042, ADR-006).
 *
 * Shipped as a source string and loaded through a Blob URL rather than a build
 * artifact. An AudioWorklet runs in its own realm and is loaded by URL, so
 * bundling one means extra build configuration for a file of about forty lines.
 * The CSP already allows `worker-src 'self' blob:`, so this path is open and
 * needs no new permission.
 *
 * The string is executed verbatim by the tests, in a VM with stubbed worklet
 * globals, so the code under test is the code that ships rather than a
 * reimplementation of it.
 *
 * Nothing here touches the filesystem, and the lint rule for this directory
 * enforces that (NFR-002).
 */

/** 16 kHz, as forced on the AudioContext (ADR-006, FR-041). */
export const TARGET_SAMPLE_RATE = 16000;

/** One second per chunk, fixed rather than a range (ADR-007, FR-042). */
export const CHUNK_DURATION_MS = 1000;

/** 16000 frames. */
export const FRAMES_PER_CHUNK = (TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000;

/** 32000 bytes: 16-bit samples, mono. */
export const BYTES_PER_CHUNK = FRAMES_PER_CHUNK * 2;

export const PCM_PROCESSOR_NAME = 'copilot-pcm-framer';

/**
 * Convert one Float32 sample to signed 16-bit.
 *
 * Negative and positive are scaled by different constants because the signed
 * 16-bit range is asymmetric: -32768 to 32767. Using 32767 for both would clip
 * the most negative sample by one bit, and using 32768 for both would overflow
 * the most positive one.
 */
export function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/**
 * The worklet's module URL.
 *
 * `pcm-processor.js` lives in the renderer's `public/` directory, so Vite copies
 * it to the output verbatim and the packaged app loads it over `file://`, which
 * the audio worker's `script-src 'self' file:` permits.
 *
 * Three things were tried, and only this one works:
 *  - A `blob:` URL is rejected: a module URL is governed by `script-src`, and
 *    the policy allows `blob:` only in `worker-src`.
 *  - `new URL('./pcm-processor.js', import.meta.url)` is rewritten by Vite into
 *    an inlined `data:` URL, which `script-src` rejects for the same reason.
 *    That one looks fixed and is not, which is why it is written down here.
 *  - A copied asset resolved against the page URL, below, stays on the page's
 *    own origin.
 *
 * Resolved against `location.href` rather than `import.meta.url` precisely so
 * the bundler leaves it alone. The page is `out/renderer/audio-worker/
 * index.html` and public files land at `out/renderer/`, hence the `../`.
 */
export const PCM_PROCESSOR_FILE = '../pcm-processor.js';

export function workletModuleUrl(): string {
  return new URL(PCM_PROCESSOR_FILE, window.location.href).href;
}
