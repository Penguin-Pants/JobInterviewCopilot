/**
 * The fault standing against the live session (`CH-217`, `NFR-008`, TASK-050).
 *
 * `CMP-15` reports every failure it survives through `onError`, and `CH-217`
 * carries the one the user must see to the Dashboard. A push alone is not
 * enough: the Dashboard can be closed and reopened mid-session
 * (`focusOrRecreateDashboard`), and a rebuilt renderer has missed every earlier
 * push with no channel to ask. It would then render the session as active with
 * no warning beside it, which is precisely the silent failure `CH-217` exists
 * to end.
 *
 * So the notice is retained here and replayed on `did-finish-load`, alongside
 * the session state itself.
 *
 * Retention is keyed by session rather than cleared on a boundary. A clear
 * would have to run at exactly the right moment, and `session:start` pushes
 * `CH-201` before it brings the loop up, so the clear and the notice arrive in
 * that order: the clear would wipe the message it was sent to replace. Asking
 * "does this notice belong to the session running now" has no such moment.
 */

/** A session-level fault and the session it happened in (`CH-217`). */
export interface SessionNotice {
  sessionId: string;
  message: string;
}

/** Retains the latest fault per session, for replay to a rebuilt Dashboard. */
export class SessionNoticeHolder {
  private notice: SessionNotice | null = null;

  /**
   * Record a fault against the session it happened in (`NFR-008`).
   *
   * A fault with no session is dropped rather than held: `CMP-15` reports
   * outside a session too, and a notice the Dashboard could never match is one
   * it would never show.
   *
   * @returns the notice to push, or null if there is nothing to say.
   */
  note(sessionId: string | undefined, message: string): SessionNotice | null {
    if (!sessionId) return null;
    this.notice = { sessionId, message };
    return this.notice;
  }

  /**
   * The fault belonging to `sessionId`, or null (`CH-217`).
   *
   * The last session's fault is not this session's, and a Dashboard that loads
   * after a clean start has nothing to show.
   */
  noticeFor(sessionId: string | undefined): SessionNotice | null {
    if (!sessionId || this.notice?.sessionId !== sessionId) return null;
    return this.notice;
  }
}
