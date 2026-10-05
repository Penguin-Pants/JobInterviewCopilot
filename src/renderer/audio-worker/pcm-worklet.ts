/**
 * Loader constants for the PCM framing worklet (CMP-03b, FR-041, FR-042, ADR-006).
 *
 * The worklet itself is `src/renderer/public/pcm-processor.js`, a plain file
 * that Vite copies to the output verbatim. `workletModuleUrl()` below says why
 * it is loaded by URL and not as a Blob or an inlined module. The tests
 * evaluate that file in a VM with stubbed worklet globals, so the code under
 * test is the code that ships.
 *
 * Nothing here touches the filesystem, and the lint rule for this directory
 * enforces that (NFR-002).
 */

/** 16 kHz, as forced on the AudioContext (ADR-006, FR-041). */
export const TARGET_SAMPLE_RATE = 16000;

/** One second per chunk, fixed rather than a range (ADR-007, FR-042): 16000 frames. */
export const FRAMES_PER_CHUNK = TARGET_SAMPLE_RATE;

export const PCM_PROCESSOR_NAME = 'copilot-pcm-framer';

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
