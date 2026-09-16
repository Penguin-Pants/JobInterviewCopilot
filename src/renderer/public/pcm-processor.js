/**
 * The PCM framing worklet. This file is the single source of truth: it ships as
 * a real asset and the unit tests evaluate this exact text (FR-041).
 *
 * It is a plain `.js` file, loaded through `new URL(..., import.meta.url)`, and
 * deliberately not a Blob. A `blob:` module URL is governed by `script-src`,
 * which the audio worker's policy restricts to `'self' file:`, so the Blob form
 * was rejected by CSP before either graph could start and no PCM was ever
 * emitted. Shipping it as an asset puts it on an allowed origin.
 */

class PcmFramer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.framesPerChunk = options.processorOptions.framesPerChunk;
    this.buffer = new Int16Array(this.framesPerChunk);
    this.filled = 0;
    this.stopped = false;

    // `stop` asks for whatever is in the buffer before the graph is torn down.
    // Without it, stopping 1.5 s in emits the first full chunk and silently
    // discards the final half second, which TASK-011 requires to be delivered.
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'flush') {
        this.flush();
        this.stopped = true;
      }
    };
  }

  /** Emits the buffered frames, whether or not the buffer is full. */
  flush() {
    if (this.filled === 0) {
      this.port.postMessage({ pcm: new ArrayBuffer(0), final: true });
      return;
    }
    // A partial chunk is sent at its true length, not padded with silence: a
    // padded tail would be transcribed as a pause that never happened.
    const partial = this.buffer.slice(0, this.filled);
    this.buffer = new Int16Array(this.framesPerChunk);
    this.filled = 0;
    this.port.postMessage({ pcm: partial.buffer, final: true }, [partial.buffer]);
  }

  /**
   * Downmixes every input channel to mono.
   *
   * Taking channel 0 alone is not a downmix: a loopback stream is routinely
   * stereo, and an interviewer whose audio sits mostly in the right channel
   * would arrive as near-silence. Averaging the channels keeps every speaker
   * audible (FR-041).
   */
  process(inputs) {
    if (this.stopped) return false;

    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelCount = input.length;
    const first = input[0];
    if (!first) return true;

    for (let i = 0; i < first.length; i += 1) {
      let sample = 0;
      for (let c = 0; c < channelCount; c += 1) {
        const channel = input[c];
        if (channel) sample += channel[i];
      }
      sample /= channelCount;

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
        this.port.postMessage({ pcm: full.buffer, final: false }, [full.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('copilot-pcm-framer', PcmFramer);
