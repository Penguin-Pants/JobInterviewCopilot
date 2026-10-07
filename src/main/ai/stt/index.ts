/**
 * Adapter registration. No filesystem imports (NFR-002).
 *
 * The one place the three streaming adapters are bound to their provider ids.
 * Adding a provider is a registry entry, an adapter file and one line here
 * (FR-037, TC-151); nothing outside this directory changes.
 */
import { registerSttProvider } from '../stt.js';
import type { SocketFactory, SocketSessionDeps } from './socket-session.js';
import { createDeepgramProvider } from './deepgram.js';
import { createElevenLabsProvider } from './elevenlabs.js';
import { createOpenAiRealtimeProvider } from './openai-realtime.js';
import { createWebSocket } from './ws-factory.js';
import { createWhisperProvider } from './whisper.js';
import type { PostWav } from './whisper.js';

/**
 * `deps.log` is the app logger, passed in because this directory may not
 * import a module that writes to disk (NFR-002).
 */
export function registerStreamingSttProviders(
  factory: SocketFactory = createWebSocket,
  deps: SocketSessionDeps = {},
): void {
  registerSttProvider(createDeepgramProvider(factory, deps));
  registerSttProvider(createOpenAiRealtimeProvider(factory, deps));
  registerSttProvider(createElevenLabsProvider(factory, deps));
}

/**
 * The batch table. `openai` appears in both tables: the streaming realtime
 * socket and `whisper-1` are different transports behind one provider id, and
 * the facade picks between them from the model's `streaming` flag.
 */
export function registerBatchSttProviders(post?: PostWav): void {
  registerSttProvider(createWhisperProvider(post), 'batch');
}

export function registerAllSttProviders(deps: SocketSessionDeps = {}): void {
  registerStreamingSttProviders(createWebSocket, deps);
  registerBatchSttProviders();
}
