/**
 * Hidden audio worker (CMP-03b, ADR-005).
 *
 * This renderer exists because neither WASAPI loopback nor getUserMedia is
 * reachable from the Electron main process. Milestone 0 only establishes the
 * entry point and proves it builds; capture, the 16 kHz AudioContexts and PCM
 * framing arrive in TASK-011, gated on the TASK-010 spike.
 *
 * Nothing in this file or anywhere under this directory may import the
 * filesystem. The lint rule enforces it (NFR-002, ADR-019).
 */

export {};
