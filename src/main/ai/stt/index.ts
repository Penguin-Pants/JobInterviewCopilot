/**
 * Adapter registration. No filesystem imports (NFR-002).
 *
 * The one place the three streaming adapters are bound to their provider ids.
 * Adding a provider is a registry entry, an adapter file and one line here
 * (FR-037, TC-151); nothing outside this directory changes.
 */
import { registerSttProvider } from '../stt.js';
import type { SocketFactory } from './socket-session.js';
import { createDeepgramProvider } from './deepgram.js';
import { createElevenLabsProvider } from './elevenlabs.js';
import { createOpenAiRealtimeProvider } from './openai-realtime.js';
import { createWebSocket } from './ws-factory.js';
import { createWhisperProvider } from './whisper.js';
import type { PostWav } from './whisper.js';

export function registerStreamingSttProviders(factory: SocketFactory = createWebSocket): void {
  registerSttProvider(createDeepgramProvider(factory));
  registerSttProvider(createOpenAiRealtimeProvider(factory));
  registerSttProvider(createElevenLabsProvider(factory));
}

/**
 * The batch table. `openai` appears in both tables: the streaming realtime
 * socket and `whisper-1` are different transports behind one provider id, and
 * the facade picks between them from the model's `streaming` flag.
 */
export function registerBatchSttProviders(post?: PostWav): void {
  registerSttProvider(createWhisperProvider(post), 'batch');
}

export function registerAllSttProviders(): void {
  registerStreamingSttProviders();
  registerBatchSttProviders();
}
