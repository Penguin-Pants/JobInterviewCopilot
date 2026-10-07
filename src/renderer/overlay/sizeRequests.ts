/**
 * The resize grip's requests to the main process (FR-081, CH-127).
 *
 * Two defects shared one cause, the window size lagging behind the requests:
 *
 * - A drag sent `overlay:setSize` on every pointer move, many per frame, and
 *   the main process resizes the window on each one.
 * - An arrow key stepped from `window.innerWidth`, which moves only once the
 *   resize has landed, so quick presses all stepped from the same size and
 *   lost steps. `FontSizeControl` solved the same with a pending draft.
 *
 * So one request is in flight at a time, at most one is sent per frame and it
 * is the newest, and the size last asked for is the base the keyboard steps
 * from. That base is dropped once nothing is pending, so the window is
 * believed again, including a size the main process or the system clamped.
 */
export interface Size {
  width: number;
  height: number;
}

export interface SizeRequestDeps {
  /** Sends one size. Settles once the main process has answered. */
  send: (size: Size) => Promise<unknown>;
  /** Runs a callback on the next frame. `requestAnimationFrame` in the overlay. */
  nextFrame: (callback: () => void) => void;
  /** The window size as the renderer sees it now. */
  current: () => Size;
}

export interface SizeRequests {
  /** Asks for a size. Coalesced with any other request made in the same frame. */
  request: (size: Size) => void;
  /** The size to step from: the size last asked for, or the window's own. */
  base: () => Size;
  /** Call on the window's `resize` event. */
  onWindowResize: () => void;
}

export function createSizeRequests({ send, nextFrame, current }: SizeRequestDeps): SizeRequests {
  let target: Size | null = null;
  let queued: Size | null = null;
  let scheduled = false;
  let inFlight = false;

  const idle = (): boolean => !inFlight && !scheduled && queued === null;

  function arm(): void {
    if (scheduled) return;
    scheduled = true;
    nextFrame(flush);
  }

  function flush(): void {
    scheduled = false;
    if (inFlight || queued === null) return;
    const size = queued;
    queued = null;
    inFlight = true;
    void send(size).finally(() => {
      inFlight = false;
      if (queued !== null) return arm();
      // The resize for this answer reaches the renderer in a following frame.
      // Wait one, then follow the window, even if no resize event came.
      nextFrame(() => {
        if (idle()) target = null;
      });
    });
  }

  return {
    request(size) {
      target = size;
      queued = size;
      arm();
    },
    base: () => target ?? current(),
    onWindowResize() {
      // A resize that lands while a request is pending is an older size than
      // the one asked for, so it is not the base yet.
      if (idle()) target = null;
    },
  };
}
