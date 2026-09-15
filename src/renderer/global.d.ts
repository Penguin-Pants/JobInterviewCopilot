import type { CopilotBridge } from '../shared/bridge.js';

declare global {
  interface Window {
    copilot: CopilotBridge;
  }
}

export {};
