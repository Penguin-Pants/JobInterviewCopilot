import type { CardEvent } from './cards.js';

export interface HoldBufferOptions {
  minHoldMs: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface QueuedEvent {
  event: Exclude<CardEvent, { kind: 'reset' }>;
  offsetMs: number;
}

export class HoldBuffer {
  private readonly dispatch: (event: CardEvent) => void;
  private readonly minHoldMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private shownId: string | null = null;
  private shownAt = 0;
  private queuedId: string | null = null;
  private queuedAt = 0;
  private queue: QueuedEvent[] = [];
  private timers: unknown[] = [];

  constructor(dispatch: (event: CardEvent) => void, options: HoldBufferOptions) {
    this.dispatch = dispatch;
    this.minHoldMs = options.minHoldMs;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  onEvent(event: CardEvent): void {
    if (event.kind === 'reset') {
      this.clearQueued();
      this.shownId = null;
      this.dispatch(event);
      return;
    }
    const id = event.payload.generationId;
    if (id === this.shownId) {
      this.dispatch(event);
      if (event.kind === 'end' && event.payload.status === 'cancelled') this.shownId = null;
      return;
    }
    if (event.kind === 'end' && event.payload.status === 'cancelled' && id === this.queuedId) {
      this.clearQueued();
      return;
    }
    if (this.shownId === null || this.now() - this.shownAt >= this.minHoldMs) {
      this.dispatchNow(event);
      return;
    }
    if (event.kind === 'begin' && this.queuedId !== null && this.queuedId !== id) {
      this.clearQueued();
    }
    if (this.queuedId === null) {
      this.queuedId = id;
      this.queuedAt = this.now();
      const delay = Math.max(0, this.shownAt + this.minHoldMs - this.now());
      this.timers.push(this.setTimer(() => this.replay(), delay));
    }
    if (this.queuedId === id) {
      this.queue.push({
        event: event as Exclude<CardEvent, { kind: 'reset' }>,
        offsetMs: this.now() - this.queuedAt,
      });
    }
  }

  onPause(): void {
    this.clearQueued();
    this.shownId = null;
  }

  dispose(): void {
    this.clearQueued();
    this.shownId = null;
  }

  private replay(): void {
    const queued = this.queue;
    this.queue = [];
    this.queuedId = null;
    this.timers = [];
    for (const item of queued) {
      if (item.offsetMs === 0) this.dispatchNow(item.event);
      else this.timers.push(this.setTimer(() => this.dispatchNow(item.event), item.offsetMs));
    }
  }

  private dispatchNow(event: Exclude<CardEvent, { kind: 'reset' }>): void {
    this.dispatch(event);
    if (event.kind === 'begin') {
      this.shownId = event.payload.generationId;
      this.shownAt = this.now();
    } else if (event.kind === 'end' && event.payload.status === 'cancelled') {
      this.shownId = null;
    }
  }

  private clearQueued(): void {
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers = [];
    this.queue = [];
    this.queuedId = null;
  }
}
