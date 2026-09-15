import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_CHUNK,
  CHUNK_DURATION_MS,
  FRAMES_PER_CHUNK,
  PCM_PROCESSOR_NAME,
  PCM_WORKLET_SOURCE,
  TARGET_SAMPLE_RATE,
  floatToInt16,
} from '../../src/renderer/audio-worker/pcm-worklet.js';

/**
 * These tests execute the shipped worklet source, not a reimplementation of it.
 * The worklet runs in its own realm and is loaded by URL, so the usual options
 * are to bundle it or to test a copy. Running the real string in a VM with
 * stubbed worklet globals avoids both: what is asserted here is what ships.
 */

interface Emitted {
  pcm: ArrayBuffer;
}

function loadProcessor(framesPerChunk = FRAMES_PER_CHUNK): {
  process: (channel: Float32Array) => void;
  emitted: Emitted[];
  transfers: ArrayBuffer[][];
} {
  const emitted: Emitted[] = [];
  const transfers: ArrayBuffer[][] = [];
  type ProcessorCtor = new (options: { processorOptions: { framesPerChunk: number } }) => {
    process(inputs: Float32Array[][]): boolean;
  };
  // Held in a box so TypeScript cannot narrow it to never. The assignment
  // happens inside the registerProcessor callback, which the checker cannot see.
  const box: { ctor: ProcessorCtor | null } = { ctor: null };

  const sandbox = {
    AudioWorkletProcessor: class {
      port = {
        postMessage: (message: Emitted, transfer: ArrayBuffer[]) => {
          emitted.push(message);
          transfers.push(transfer);
        },
      };
    },
    registerProcessor: (name: string, ctor: unknown) => {
      expect(name).toBe(PCM_PROCESSOR_NAME);
      box.ctor = ctor as ProcessorCtor;
    },
    Int16Array,
    Math,
  };

  runInContext(PCM_WORKLET_SOURCE, createContext(sandbox));
  if (!box.ctor) throw new Error('worklet did not register a processor');

  const instance = new box.ctor({ processorOptions: { framesPerChunk } });
  return {
    process: (channel: Float32Array) => {
      instance.process([[channel]]);
    },
    emitted,
    transfers,
  };
}

/** TC-040: the conversion and the framing. */
describe('TC-040 PCM framing', () => {
  it('uses the documented constants', () => {
    expect(TARGET_SAMPLE_RATE).toBe(16000);
    expect(CHUNK_DURATION_MS).toBe(1000);
    expect(FRAMES_PER_CHUNK).toBe(16000);
    expect(BYTES_PER_CHUNK).toBe(32000);
  });

  it('converts known Float32 values to the expected Int16 values', () => {
    expect(floatToInt16(0)).toBe(0);
    expect(floatToInt16(1)).toBe(32767);
    expect(floatToInt16(-1)).toBe(-32768);
    expect(floatToInt16(0.5)).toBe(16384);
    expect(floatToInt16(-0.5)).toBe(-16384);
  });

  it('clamps out-of-range input rather than wrapping it', () => {
    // A wrap would turn the loudest possible sample into the quietest, which
    // is an audible click rather than a clean clip.
    expect(floatToInt16(2)).toBe(32767);
    expect(floatToInt16(-2)).toBe(-32768);
  });

  it('scales negative and positive by different constants', () => {
    // The signed 16-bit range is asymmetric. One constant for both would either
    // clip the most negative sample or overflow the most positive one.
    expect(Math.abs(floatToInt16(-1))).toBeGreaterThan(Math.abs(floatToInt16(1)));
  });

  it('emits nothing until a whole chunk is filled', () => {
    const { process, emitted } = loadProcessor();
    for (let i = 0; i < 124; i += 1) process(new Float32Array(128));
    expect(emitted).toHaveLength(0);
  });

  it('emits exactly one chunk of 32000 bytes per 16000 frames', () => {
    const { process, emitted } = loadProcessor();
    // 125 quanta of 128 frames is exactly 16000 frames.
    for (let i = 0; i < 125; i += 1) process(new Float32Array(128));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.pcm.byteLength).toBe(BYTES_PER_CHUNK);
  });

  it('preserves the samples through the conversion', () => {
    const { process, emitted } = loadProcessor(4);
    const input = new Float32Array([0, 1, -1, 0.5]);
    process(input);

    const view = new Int16Array(emitted[0]!.pcm);
    expect(Array.from(view)).toEqual([0, 32767, -32768, 16384]);
  });

  it('writes little-endian, as the providers expect', () => {
    const { process, emitted } = loadProcessor(2);
    process(new Float32Array([1, 0]));

    const bytes = new Uint8Array(emitted[0]!.pcm);
    // 32767 = 0x7FFF, little-endian is FF 7F.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0x7f);
  });

  it('keeps emitting on a chunk boundary that falls mid-quantum', () => {
    const { process, emitted } = loadProcessor(100);
    process(new Float32Array(250));
    expect(emitted).toHaveLength(2);
    expect(emitted[0]!.pcm.byteLength).toBe(200);
  });
});

/** TC-136: the duration is exactly 1000 ms, not approximately. */
describe('TC-136 chunk duration is exactly 1000 ms', () => {
  it('is 16000 frames at 16 kHz, so 999 or 1001 ms would fail', () => {
    expect(FRAMES_PER_CHUNK / TARGET_SAMPLE_RATE).toBe(1);
    expect((FRAMES_PER_CHUNK * 1000) / TARGET_SAMPLE_RATE).toBe(1000);
  });

  it('a chunk is 32000 bytes and nothing else', () => {
    const { process, emitted } = loadProcessor();
    for (let i = 0; i < 125; i += 1) process(new Float32Array(128));
    expect(emitted[0]!.pcm.byteLength).toBe(32000);
  });
});

/** TC-041: retention is bounded (ADR-027). */
describe('TC-041 the worklet retains no emitted chunk', () => {
  it('transfers each chunk away, so the processor cannot hold it', () => {
    const { process, emitted, transfers } = loadProcessor(128);
    process(new Float32Array(128));

    expect(transfers[0]).toHaveLength(1);
    expect(transfers[0]![0]).toBe(emitted[0]!.pcm);
  });

  it('allocates a fresh buffer per chunk rather than reusing one', () => {
    const { process, emitted } = loadProcessor(128);
    process(new Float32Array(128));
    process(new Float32Array(128));

    expect(emitted).toHaveLength(2);
    // Reuse would mean the first chunk's contents are overwritten by the
    // second, which is a silent data-corruption bug rather than a crash.
    expect(emitted[0]!.pcm).not.toBe(emitted[1]!.pcm);
  });

  it('holds at most one partial chunk regardless of how long it runs', () => {
    const { process, emitted } = loadProcessor(128);
    for (let i = 0; i < 600; i += 1) process(new Float32Array(128));

    expect(emitted).toHaveLength(600);
    // Every chunk was handed out; nothing accumulated inside the processor.
    for (const chunk of emitted) expect(chunk.pcm.byteLength).toBe(256);
  });
});
