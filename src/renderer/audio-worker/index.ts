import { getLoopbackStream, getMicrophoneStream, StreamAcquisitionError } from './capture.js';
import {
  FRAMES_PER_CHUNK,
  PCM_PROCESSOR_NAME,
  TARGET_SAMPLE_RATE,
  workletModuleUrl,
} from './pcm-worklet.js';
import type { TranscriptSource } from '../../shared/types.js';

/**
 * Hidden audio worker (CMP-03b, ADR-005).
 *
 * This renderer exists because neither loopback nor `getUserMedia` is reachable
 * from the Electron main process. It has no UI and never persists anything.
 *
 * Each stream gets its own graph, and the two are never connected: mixing them
 * would destroy the distinction the whole product depends on, between what the
 * interviewer said and what the candidate said (FR-040).
 *
 * Resampling is done by forcing the context to 16 kHz rather than decimating by
 * hand, which would need a low-pass filter to avoid aliasing and would add a
 * defect surface for no benefit (ADR-006).
 */

interface WorkerBridge {
  onStart(listener: (payload: { streams: TranscriptSource[] }) => void): void;
  onStop(listener: () => void): void;
  sendChunk(
    meta: { source: TranscriptSource; timestamp: number; sequence: number },
    pcm: ArrayBuffer,
  ): void;
  sendStreamState(payload: { source: TranscriptSource; state: string; error?: string }): void;
}

declare global {
  interface Window {
    audioWorker: WorkerBridge;
  }
}

interface StreamGraph {
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
}

const graphs = new Map<TranscriptSource, StreamGraph>();

/**
 * The per-source chunk counter.
 *
 * It lives outside the graph because a graph is replaceable: an unexpected
 * stream end restarts it (FR-045), and a counter inside would reset to zero so
 * the first chunk after a recovery repeated sequence 1. The supervisor's gap
 * detection would then see a duplicate exactly on the path it exists to watch.
 * Reset only when the whole session stops.
 */
const sequences = new Map<TranscriptSource, number>();

function nextSequence(source: TranscriptSource): number {
  const next = (sequences.get(source) ?? 0) + 1;
  sequences.set(source, next);
  return next;
}

async function startStream(source: TranscriptSource): Promise<void> {
  window.audioWorker.sendStreamState({ source, state: 'starting' });

  const stream = source === 'interviewer' ? await getLoopbackStream() : await getMicrophoneStream();

  // Everything past this point can throw, and the stream is already live. A
  // failure that left it running would keep the microphone or system audio
  // captured invisibly for the rest of the session while its state read
  // `error`, so setup is wrapped and the tracks are released on any failure.
  let context: AudioContext | null = null;
  try {
    // Forcing the rate here is what makes every provider's 16 kHz requirement a
    // property of the graph rather than something to convert later (ADR-006).
    context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });

    await context.audioWorklet.addModule(workletModuleUrl());

    const node = new AudioWorkletNode(context, PCM_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { framesPerChunk: FRAMES_PER_CHUNK },
    });

    node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; final?: boolean }>) => {
      // The flush on stop can produce an empty buffer when the graph happened
      // to end on a chunk boundary. Sending it would be a zero-length chunk.
      if (event.data.pcm.byteLength === 0) return;
      // The buffer is handed straight on and not stored. Electron copies it
      // across IPC, which is fine; holding it would not be (ADR-027).
      window.audioWorker.sendChunk(
        { source, timestamp: Date.now(), sequence: nextSequence(source) },
        event.data.pcm,
      );
    };

    context.createMediaStreamSource(stream).connect(node);

    // A track can end on its own, for example when the device is unplugged or
    // the user revokes the share. Report it so the supervisor can restart
    // (FR-045).
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        window.audioWorker.sendStreamState({
          source,
          state: 'error',
          error: 'The audio track ended unexpectedly.',
        });
      });
    }

    graphs.set(source, { stream, context, node });
    window.audioWorker.sendStreamState({ source, state: 'running' });
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    if (context) await context.close().catch(() => undefined);
    throw err;
  }
}

async function stopStream(source: TranscriptSource): Promise<void> {
  const graph = graphs.get(source);
  if (!graph) return;
  graphs.delete(source);

  // Ask for the tail before tearing anything down. Stopping mid-second would
  // otherwise discard the frames buffered since the last full chunk, and the
  // last thing said before the stop is exactly what a user wants transcribed.
  await flushWorklet(graph.node);

  graph.node.port.onmessage = null;
  graph.node.disconnect();
  for (const track of graph.stream.getTracks()) track.stop();
  await graph.context.close();

  window.audioWorker.sendStreamState({ source, state: 'idle' });
}

/** How long to wait for the worklet's final chunk before giving up on it. */
const FLUSH_TIMEOUT_MS = 250;

/**
 * Asks the processor to emit its partial buffer and waits for it.
 *
 * Bounded, because a worklet that has already died would otherwise hang the
 * stop path forever, and a stop that never completes is worse than a lost
 * half second.
 */
function flushWorklet(node: AudioWorkletNode): Promise<void> {
  return new Promise<void>((resolve) => {
    const previous = node.port.onmessage;
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, FLUSH_TIMEOUT_MS);

    node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; final?: boolean }>) => {
      previous?.call(node.port, event);
      if (event.data.final === true) done();
    };
    node.port.postMessage({ type: 'flush' });
  });
}

async function stopAll(): Promise<void> {
  await Promise.all([...graphs.keys()].map(stopStream));
  // A new session starts counting from one. A restart within a session does
  // not, which is the distinction the counter exists to make.
  sequences.clear();
}

window.audioWorker.onStart(({ streams }) => {
  void (async () => {
    for (const source of streams) {
      try {
        // Restarting a source that is already running would leave two graphs
        // feeding the same STT session.
        await stopStream(source);
        await startStream(source);
      } catch (err) {
        const message =
          err instanceof StreamAcquisitionError
            ? err.message
            : `Unexpected failure: ${String(err)}`;
        window.audioWorker.sendStreamState({ source, state: 'error', error: message });
      }
    }
  })();
});

window.audioWorker.onStop(() => {
  void stopAll();
});

export {};
