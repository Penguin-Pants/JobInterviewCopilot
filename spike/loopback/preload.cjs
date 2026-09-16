/**
 * TASK-010 spike preload. Deliberately tiny: the whole point is that the
 * renderer does NOT need ipcRenderer to acquire the loopback stream, only to
 * report what it found.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  report: (payload) => ipcRenderer.send('spike:result', payload),
});
