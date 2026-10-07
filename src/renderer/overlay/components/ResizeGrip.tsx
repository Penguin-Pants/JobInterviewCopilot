import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { SETTINGS_LIMITS } from '../../../shared/defaults.js';
import { createSizeRequests, type Size } from '../sizeRequests.js';

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
 * until the user dragged all the way back. The one exception is a size asked
 * for and not landed yet, which `sizeRequests.ts` holds until nothing is
 * pending, so quick arrow presses do not step from a stale viewport.
 */
export interface ResizeGripProps {
  /** Send a new window size. Settles when the main process answers (CH-127). */
  onResize: (size: Size) => Promise<unknown>;
}

const LIMITS = SETTINGS_LIMITS;

/** One arrow-key press, in pixels. There is no drag to derive a step from. */
const KEYBOARD_STEP_PX = 20;

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

  // A ref, so the requester built once below always sends through the newest
  // callback the overlay passed.
  const send = useRef(onResize);
  send.current = onResize;
  const [requests] = useState(() =>
    createSizeRequests({
      send: (next) => send.current(next),
      nextFrame: (callback) => requestAnimationFrame(() => callback()),
      current: () => ({ width: window.innerWidth, height: window.innerHeight }),
    }),
  );

  /**
   * The window's current size, for the separator's ARIA value (NFR-010).
   *
   * A focusable `role="separator"` is a widget with a value, and this one
   * carries two: `window.innerWidth`/`Height` are the source of truth, so
   * both are read from there rather than accumulated from resize deltas,
   * same reason `onPointerMove` and `onKeyDown` do. The `resize` listener
   * catches every cause, not only this grip's own drag and key presses: a
   * size the main process clamped, or one restored from a persisted setting
   * on load, moves the window without either handler ever running.
   */
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const handleWindowResize = (): void => {
      setSize({ width: window.innerWidth, height: window.innerHeight });
      requests.onWindowResize();
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [requests]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Pointer capture is what keeps the drag alive once the pointer leaves the
      // grip, which it does immediately when the window is made smaller than the
      // pointer's travel.
      event.currentTarget.setPointerCapture(event.pointerId);
      origin.current = { x: event.clientX, y: event.clientY, ...requests.base() };
      event.preventDefault();
    },
    [requests],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = origin.current;
      if (!start) return;
      // Coalesced to one request per frame, the newest, with one in flight.
      requests.request({
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
    [requests],
  );

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    origin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /**
   * The grip used to be pointer-only, which left resizing entirely
   * unreachable from the keyboard (NFR-010). Arrow keys step both dimensions
   * from the size last asked for, or the window size once nothing is pending,
   * and are clamped through the same `LIMITS` a drag is.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      let dx = 0;
      let dy = 0;
      switch (event.key) {
        case 'ArrowRight':
          dx = KEYBOARD_STEP_PX;
          break;
        case 'ArrowLeft':
          dx = -KEYBOARD_STEP_PX;
          break;
        case 'ArrowDown':
          dy = KEYBOARD_STEP_PX;
          break;
        case 'ArrowUp':
          dy = -KEYBOARD_STEP_PX;
          break;
        default:
          return;
      }
      event.preventDefault();
      const from = requests.base();
      requests.request({
        width: clamp(from.width + dx, LIMITS.overlayWidthPx.min, LIMITS.overlayWidthPx.max),
        height: clamp(from.height + dy, LIMITS.overlayHeightPx.min, LIMITS.overlayHeightPx.max),
      });
    },
    [requests],
  );

  return (
    <div
      data-testid="overlay-resize-grip"
      // Without this the shell's drag region swallows the pointer and the grip
      // moves the window instead of resizing it (FR-082).
      data-no-drag="true"
      className="overlay-resize-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the overlay. Arrow keys resize; drag for free resizing."
      // Two dimensions, and a single `aria-valuenow` names only one. Width is
      // that one, since it is the axis `aria-orientation` already names as
      // primary; `aria-valuetext` carries the whole state, height included,
      // for anything that reads it instead of the bare number.
      aria-valuemin={LIMITS.overlayWidthPx.min}
      aria-valuemax={LIMITS.overlayWidthPx.max}
      aria-valuenow={size.width}
      aria-valuetext={`${size.width} by ${size.height} pixels`}
      title="Drag to resize"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
