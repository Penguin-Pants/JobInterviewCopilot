/**
 * A WAV container built in memory. No filesystem imports (NFR-002).
 *
 * `whisper-1` is a REST endpoint that wants a file, not a raw PCM stream. The
 * obvious way to give it one is to write a temp file and hand over the path,
 * and that is exactly what NFR-002 forbids: audio bytes must never reach disk.
 * So the container is built here, 44 bytes of header in front of the PCM the
 * audio worker already produced, and posted from memory (ADR-019).
 *
 * This is why no encoder package appears in the dependency table.
 */

export const WAV_HEADER_BYTES = 44;

const BITS_PER_SAMPLE = 16;

/**
 * Wraps PCM chunks in a RIFF/WAVE container. The chunks are concatenated in the
 * order given; no chunk is retained after the copy (ADR-027).
 */
export function encodeWav(chunks: ArrayBuffer[], sampleRate = 16000, channels = 1): Uint8Array {
  const dataBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);

  const blockAlign = (channels * BITS_PER_SAMPLE) / 8;

  writeAscii(out, 0, 'RIFF');
  // Everything after this field: the remaining 36 header bytes plus the data.
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(out, 8, 'WAVE');

  writeAscii(out, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(out, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return out;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) target[offset + i] = text.charCodeAt(i);
}
