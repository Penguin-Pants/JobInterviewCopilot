/**
 * TASK-050, TC-132. The retention behind `CH-217`.
 *
 * `index.ts` is two lines of glue over this: log, `note`, push; and on
 * `did-finish-load`, `noticeFor` and push. The decisions, which session a fault
 * belongs to and whether a rebuilt Dashboard should be told about it, are all
 * here, where a test can reach them.
 */
import { describe, expect, it } from 'vitest';
import { SessionNoticeHolder } from '../../src/main/session-notice.js';

const MESSAGE =
  'transcription is unavailable: the speech-to-text model is not usable. ' +
  'The session is running, but nothing will be transcribed.';

describe('TC-132 a session fault is retained for the session it happened in', () => {
  it('returns the notice to push, tagged with its session', () => {
    const holder = new SessionNoticeHolder();
    expect(holder.note('s1', MESSAGE)).toEqual({ sessionId: 's1', message: MESSAGE });
  });

  it('replays it to a Dashboard rebuilt during the same session', () => {
    const holder = new SessionNoticeHolder();
    holder.note('s1', MESSAGE);

    // What `did-finish-load` asks after `focusOrRecreateDashboard` built a new
    // renderer. Without this the reopened Dashboard renders a live session with
    // no warning beside it (NFR-008).
    expect(holder.noticeFor('s1')).toEqual({ sessionId: 's1', message: MESSAGE });
  });

  it('keeps only the latest fault of a session', () => {
    const holder = new SessionNoticeHolder();
    holder.note('s1', 'the first thing that went wrong');
    holder.note('s1', MESSAGE);
    expect(holder.noticeFor('s1')).toEqual({ sessionId: 's1', message: MESSAGE });
  });

  it('does not hand the previous session fault to the next session', () => {
    const holder = new SessionNoticeHolder();
    holder.note('s1', MESSAGE);
    // The next interview starts clean. Keying by session is what removes the
    // need for a clear that would race `CH-201`.
    expect(holder.noticeFor('s2')).toBeNull();
  });

  it('has nothing to say when no session is running', () => {
    const holder = new SessionNoticeHolder();
    expect(holder.noticeFor(undefined)).toBeNull();

    holder.note('s1', MESSAGE);
    expect(holder.noticeFor(undefined)).toBeNull();
  });

  it('drops a fault raised outside a session rather than holding it', () => {
    const holder = new SessionNoticeHolder();
    // `CMP-15` reports outside a session too. A notice the Dashboard could
    // never match is one it would never show.
    expect(holder.note(undefined, 'a fault with no session')).toBeNull();
    expect(holder.noticeFor('s1')).toBeNull();
  });

  it('does not let a fault outside a session erase the live one', () => {
    const holder = new SessionNoticeHolder();
    holder.note('s1', MESSAGE);
    holder.note(undefined, 'a fault after the session stopped');
    expect(holder.noticeFor('s1')).toEqual({ sessionId: 's1', message: MESSAGE });
  });
});
