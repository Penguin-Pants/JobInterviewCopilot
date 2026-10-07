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

/**
 * Whether focus is still inside one of `regions` (NFR-010).
 *
 * A dialog that closes after a round trip must not pull focus from wherever
 * the user moved it during the wait. Focus is moved only when it is still in a
 * place that is about to go away, such as the dialog or the row it deleted.
 */
export function focusWithin(
  active: Node | null,
  regions: ReadonlyArray<Pick<Node, 'contains'> | null | undefined>,
): boolean {
  if (active === null) return false;
  return regions.some((region) => region?.contains(active) ?? false);
}
