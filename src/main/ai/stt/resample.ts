/**
 * 16 kHz to 24 kHz PCM resampling. No filesystem imports (NFR-002).
 *
 * The Audio Worker emits 16 kHz, 16-bit, mono PCM (FR-041). OpenAI realtime
 * accepts `pcm16` only at 24 kHz (ADR-056), so its adapter upsamples here.
 * The other streaming providers take 16 kHz directly.
 */

/**
 * A stateful 2:3 linear-interpolation upsampler.
 *
 * State carries across chunks, so the output for a stream does not depend on
 * how it was chunked: no sample is dropped or repeated at a chunk boundary.
 * Positions are counted in thirds of an input sample, so the arithmetic is
 * exact integers and never drifts over a long interview. Output sample `j`
 * sits at input position `2j / 3`.
 */
export function createUpsampler16kTo24k(): (pcm: ArrayBuffer) => Int16Array {
  // Position of the next output sample, in thirds of an input sample, relative
  // to the first sample of the next chunk. -1 or -2 means it falls between the
  // previous chunk's last sample and this chunk's first.
  let next = 0;
  let previous = 0;

  return (pcm) => {
    const input = new DataView(pcm);
    const count = Math.floor(pcm.byteLength / 2);
    if (count === 0) return new Int16Array(0);
    const sample = (i: number) => (i < 0 ? previous : input.getInt16(i * 2, true));

    const out: number[] = [];
    const last = (count - 1) * 3;
    for (; next <= last; next += 2) {
      const i = Math.floor(next / 3);
      const thirds = next - i * 3;
      const s0 = sample(i);
      out.push(thirds === 0 ? s0 : Math.round(s0 + ((sample(i + 1) - s0) * thirds) / 3));
    }
    next -= count * 3;
    previous = sample(count - 1);
    // Interpolating between two int16 values cannot leave the int16 range, so
    // no clamp is needed.
    return Int16Array.from(out);
  };
}
