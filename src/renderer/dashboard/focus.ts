/**
 * Moves keyboard focus to an element once React has rendered it (NFR-010).
 *
 * A state change that opens, closes or replaces a control renders after the
 * handler that made it returns, so the element to focus may not exist yet, or
 * may not be in the Tab order yet. One frame later it is. An element that is
 * not a control needs `tabIndex={-1}` to take focus.
 */
export function focusLater(id: string): void {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}
