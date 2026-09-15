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

/** The worklet source. Kept in one string so the tests run exactly this. */
export const PCM_WORKLET_SOURCE = `
class PcmFramer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.framesPerChunk = options.processorOptions.framesPerChunk;
    this.buffer = new Int16Array(this.framesPerChunk);
    this.filled = 0;
  }

  /**
   * Mono only. A loopback or microphone stream can arrive with more than one
   * channel; taking channel 0 rather than averaging keeps this deterministic
   * and matches what the STT providers are configured to expect (FR-041).
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      const sample = channel[i];
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      this.buffer[this.filled] =
        clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
      this.filled += 1;

      if (this.filled === this.framesPerChunk) {
        // A fresh buffer is allocated for the next chunk and the full one is
        // transferred away, so this processor never holds a reference to a
        // chunk it has already emitted (FR-043, ADR-027).
        const full = this.buffer;
        this.buffer = new Int16Array(this.framesPerChunk);
        this.filled = 0;
        this.port.postMessage({ pcm: full.buffer }, [full.buffer]);
      }
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(PCM_PROCESSOR_NAME)}, PcmFramer);
`;

/**
 * Build the Blob URL the AudioContext loads the processor from.
 * The caller revokes it once `addModule` has resolved.
 */
export function createWorkletModuleUrl(): string {
  const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
