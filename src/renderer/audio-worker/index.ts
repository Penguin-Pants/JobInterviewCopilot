import { getLoopbackStream, getMicrophoneStream, StreamAcquisitionError } from './capture.js';
import {
  createWorkletModuleUrl,
  FRAMES_PER_CHUNK,
  PCM_PROCESSOR_NAME,
  TARGET_SAMPLE_RATE,
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
  sequence: number;
}

const graphs = new Map<TranscriptSource, StreamGraph>();

async function startStream(source: TranscriptSource): Promise<void> {
  window.audioWorker.sendStreamState({ source, state: 'starting' });

  const stream = source === 'interviewer' ? await getLoopbackStream() : await getMicrophoneStream();

  // Forcing the rate here is what makes every provider's 16 kHz requirement a
  // property of the graph rather than something to convert later (ADR-006).
  const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });

  const moduleUrl = createWorkletModuleUrl();
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    // Revoked as soon as it has been consumed, so the blob cannot outlive it.
    URL.revokeObjectURL(moduleUrl);
  }

  const node = new AudioWorkletNode(context, PCM_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { framesPerChunk: FRAMES_PER_CHUNK },
  });

  const graph: StreamGraph = { stream, context, node, sequence: 0 };

  node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer }>) => {
    graph.sequence += 1;
    // The buffer is handed straight on and not stored. Electron copies it
    // across IPC, which is fine; holding it would not be (ADR-027).
    window.audioWorker.sendChunk(
      { source, timestamp: Date.now(), sequence: graph.sequence },
      event.data.pcm,
    );
  };

  context.createMediaStreamSource(stream).connect(node);

  // A track can end on its own, for example when the device is unplugged or the
  // user revokes the share. Report it so the supervisor can restart (FR-045).
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      window.audioWorker.sendStreamState({
        source,
        state: 'error',
        error: 'The audio track ended unexpectedly.',
      });
    });
  }

  graphs.set(source, graph);
  window.audioWorker.sendStreamState({ source, state: 'running' });
}

async function stopStream(source: TranscriptSource): Promise<void> {
  const graph = graphs.get(source);
  if (!graph) return;
  graphs.delete(source);

  graph.node.port.onmessage = null;
  graph.node.disconnect();
  for (const track of graph.stream.getTracks()) track.stop();
  await graph.context.close();

  window.audioWorker.sendStreamState({ source, state: 'idle' });
}

async function stopAll(): Promise<void> {
  await Promise.all([...graphs.keys()].map(stopStream));
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
