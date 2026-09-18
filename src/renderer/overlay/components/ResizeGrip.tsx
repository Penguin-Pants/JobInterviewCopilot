import { useCallback, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { SETTINGS_LIMITS } from '../../../shared/defaults.js';

/**
 * The overlay's resize grip (FR-081, CH-127, TASK-052).
 *
 * The overlay is frameless, so there is no operating-system border to drag, and
 * Electron warns that a `transparent` window may stop working when it is made
 * resizable, which is what the flat-opacity translucency mode builds. The
 * window carries `resizable: true` so the acrylic mode gets native edges, and
 * this grip is what makes resizing work in both modes and behave the same in
 * each.
 *
 * It is rendered only in interactive mode, for the same reason `FontSizeControl`
 * is: in click-through mode the window passes every click to the application
 * behind it, so a grip drawn there would be a control that cannot be used and a
 * promise the overlay cannot keep (FR-083, FR-084).
 *
 * Sizes are computed from the viewport rather than accumulated from the
 * deltas, because the main process clamps what it applies and an accumulator
 * would keep counting past the clamp: the pointer would end up far outside the
 * window it is supposed to be dragging, and the grip would then do nothing
 * until the user dragged all the way back.
 */
export interface ResizeGripProps {
  /** Send a new window size. Rate limited in the main process (CH-127). */
  onResize: (size: { width: number; height: number }) => void;
}

const LIMITS = SETTINGS_LIMITS;

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function ResizeGrip({ onResize }: ResizeGripProps): JSX.Element {
  /**
   * The viewport and the pointer at the moment the drag began.
   *
   * Held in a ref rather than in state: it changes on every pointer move and
   * nothing renders from it, so putting it in state would re-render the whole
   * overlay for each frame of a drag.
   */
  const origin = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // Pointer capture is what keeps the drag alive once the pointer leaves the
    // grip, which it does immediately when the window is made smaller than the
    // pointer's travel.
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = {
      x: event.clientX,
      y: event.clientY,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    event.preventDefault();
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = origin.current;
      if (!start) return;
      onResize({
        width: clamp(
          start.width + (event.clientX - start.x),
          LIMITS.overlayWidthPx.min,
          LIMITS.overlayWidthPx.max,
        ),
        height: clamp(
          start.height + (event.clientY - start.y),
          LIMITS.overlayHeightPx.min,
          LIMITS.overlayHeightPx.max,
        ),
      });
    },
    [onResize],
  );

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    origin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      data-testid="overlay-resize-grip"
      // Without this the shell's drag region swallows the pointer and the grip
      // moves the window instead of resizing it (FR-082).
      data-no-drag="true"
      className="overlay-resize-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the overlay"
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
