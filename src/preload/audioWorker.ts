import { contextBridge, ipcRenderer } from 'electron';

/**
 * The audio worker bridge (CMP-03b, ADR-005).
 *
 * Narrow on purpose. The worker sends PCM chunks and stream state and receives
 * start and stop. It has no access to settings, secrets or any other channel,
 * and it never persists anything (NFR-002).
 *
 * KNOWN ISSUE, see docs/00-decision-log.md OQ-003.
 * The architecture says CH-303 transfers the ArrayBuffer so the sender's
 * reference is neutered. Electron cannot do that: both
 * `ipcRenderer.postMessage` and `MessagePortMain.postMessage` accept only
 * MessagePort values in their transfer list, so every buffer crossing Electron
 * IPC is structured-cloned, meaning copied. The buffer is sent by copy here and
 * the design question is left open for TASK-011 rather than papered over.
 * This does not weaken NFR-002: a copy in memory is still never written to
 * disk, and the runtime filesystem-write monitor (TC-137) is what proves it.
 */
contextBridge.exposeInMainWorld('audioWorker', {
  onStart: (listener: (payload: { streams: Array<'interviewer' | 'candidate'> }) => void) => {
    ipcRenderer.on('audio:start', (_e, payload) => listener(payload));
  },
  onStop: (listener: () => void) => {
    ipcRenderer.on('audio:stop', () => listener());
  },
  sendChunk: (meta: { source: string; timestamp: number; sequence: number }, pcm: ArrayBuffer) => {
    ipcRenderer.send('audio:chunk', meta, pcm);
  },
  sendStreamState: (payload: { source: string; state: string; error?: string }) => {
    ipcRenderer.send('audio:streamState', payload);
  },
});
