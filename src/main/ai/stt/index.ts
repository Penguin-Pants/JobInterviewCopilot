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

export function registerStreamingSttProviders(factory: SocketFactory = createWebSocket): void {
  registerSttProvider(createDeepgramProvider(factory));
  registerSttProvider(createOpenAiRealtimeProvider(factory));
  registerSttProvider(createElevenLabsProvider(factory));
}
