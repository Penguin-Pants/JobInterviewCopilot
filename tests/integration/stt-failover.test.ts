/**
 * Failover through the real streaming adapters (ADR-010, ADR-036, ADR-054).
 *
 * The live loop, the real `ProviderHealthRegistry` and the real Deepgram and
 * ElevenLabs adapters, over a fake socket that fails the way a real one does:
 * asynchronously, after the adapter's `open` has been called. Before ADR-054
 * every streaming `open` resolved before its socket connected, so the health
 * machine recorded each refused attempt as a success, reset to the primary and
 * never reached the backup.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../src/shared/defaults.js';
import { clearSttProviders, registerSttProvider } from '../../src/main/ai/stt.js';
import type { ConnectSpec, SocketLike } from '../../src/main/ai/stt/socket-session.js';
import { createDeepgramProvider } from '../../src/main/ai/stt/deepgram.js';
import { createElevenLabsProvider } from '../../src/main/ai/stt/elevenlabs.js';
import { FakeSocket } from '../fakes/socket.js';
import { harness, startSession, stopSession } from '../fakes/live-harness.js';

const PRIMARY = { providerId: 'deepgram', modelId: 'nova-3' };
const BACKUP = { providerId: 'elevenlabs', modelId: 'scribe-v2-realtime' };

/** A socket that answers the way the provider's server would, one tick later. */
class ServerSocket extends FakeSocket {
  override send(data: string | Uint8Array): void {
    super.send(data);
    if (typeof data !== 'string') return;
    const frame = JSON.parse(data) as Record<string, unknown>;
    // ElevenLabs answers a commit with the committed segment.
    if (frame.commit === true) {
      setTimeout(() => this.receive({ message_type: 'committed_transcript', text: '' }), 0);
    }
    // Deepgram closes the socket after CloseStream.
    if (frame.type === 'CloseStream') setTimeout(() => this.dropped(1000, ''), 0);
  }
}

/**
 * Deepgram accepts the first `acceptDeepgram` sockets and refuses every one
 * after that. ElevenLabs always accepts.
 */
function providers(acceptDeepgram: number) {
  const deepgram: ServerSocket[] = [];
  const elevenlabs: ServerSocket[] = [];
  const factory = (spec: ConnectSpec): SocketLike => {
    const socket = new ServerSocket(spec);
    if (spec.url.includes('deepgram')) {
      const accept = deepgram.length < acceptDeepgram;
      deepgram.push(socket);
      setTimeout(() => (accept ? socket.opened() : socket.dropped(1006, '')), 0);
    } else {
      elevenlabs.push(socket);
      setTimeout(() => {
        socket.opened();
        socket.receive({ message_type: 'session_started', session_id: 's' });
      }, 0);
    }
    return socket;
  };
  registerSttProvider(createDeepgramProvider(factory));
  registerSttProvider(createElevenLabsProvider(factory));
  return { deepgram, elevenlabs };
}

let userData = '';

beforeEach(() => {
  clearSttProviders();
  userData = mkdtempSync(join(tmpdir(), 'icp-failover-'));
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

function failoverHarness() {
  const base = defaultSettings();
  const h = harness(userData, {
    registerStt: false,
    settings: { providers: { ...base.providers, stt: { primary: PRIMARY, backup: BACKUP } } },
  });
  h.health.bind({ capability: 'stt', primary: 'deepgram', backup: 'elevenlabs' });
  return h;
}

describe('a refused primary socket fails over to the backup', () => {
  it('opens the backup pair when the primary refuses every connection at start', async () => {
    const sockets = providers(0);
    const h = failoverHarness();
    await startSession(h);

    expect(h.health.snapshot().stt.kind).toBe('using-backup');
    // One refused first attempt plus the three retries of the ladder, then the backup.
    expect(sockets.deepgram).toHaveLength(4);
    expect(sockets.elevenlabs).toHaveLength(2);
    expect(h.live.openStreamCount).toBe(2);

    await stopSession(h);
  });

  it('opens the backup pair when the primary dies mid-session and will not come back', async () => {
    // The first pair connects, then every later Deepgram socket is refused.
    const sockets = providers(2);
    const h = failoverHarness();
    await startSession(h);
    expect(h.health.snapshot().stt.kind).toBe('using-primary');
    expect(sockets.elevenlabs).toHaveLength(0);

    sockets.deepgram[0]!.dropped(1006, '');

    // The adapter's own ladder runs on real time (250 + 500 + 1000 ms), then
    // the health machine's ladder, then the backup.
    await vi.waitFor(() => expect(sockets.elevenlabs).toHaveLength(2), {
      timeout: 8000,
      interval: 50,
    });
    await vi.waitFor(() => expect(h.live.openStreamCount).toBe(2), { timeout: 2000 });
    expect(h.health.snapshot().stt.kind).toBe('using-backup');

    await stopSession(h);
  });
});
