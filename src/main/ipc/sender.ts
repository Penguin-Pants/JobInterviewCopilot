import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Who sent an IPC message (FR-086, CMP-10).
 *
 * Pure, so the checks the router and the audio host apply are unit tested
 * without an Electron runtime.
 */

/** The parts of Electron's `WebFrameMain` these checks read. */
export interface SenderFrame {
  readonly url: string;
  readonly parent: unknown;
}

/**
 * A predicate for "this URL is one of this app's own renderer pages".
 *
 * In development every page comes from the electron-vite dev server, so the
 * origin is what identifies it. Packaged, every page is a `file:` URL under the
 * renderer output directory. The path is compared as a path, not as a string
 * prefix, so `..` segments and percent-encoding cannot step outside it, and
 * Windows drive-letter case does not matter.
 */
export function appRendererUrlCheck(
  devServerUrl: string | undefined,
  rendererDir: string,
): (url: string) => boolean {
  if (devServerUrl) {
    const origin = new URL(devServerUrl).origin;
    return (url) => {
      try {
        return new URL(url).origin === origin;
      } catch {
        return false;
      }
    };
  }
  return (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'file:') return false;
      const inside = relative(rendererDir, fileURLToPath(parsed));
      return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
    } catch {
      return false;
    }
  };
}

/**
 * True when a message came from the top-level document of an app page.
 *
 * A null frame means the sender navigated or was destroyed while the message
 * was in flight, so nothing can be said about it and it is refused. A child
 * frame is refused because no page in this app embeds one.
 */
export function isTopLevelAppFrame(
  frame: SenderFrame | null | undefined,
  isAppUrl: (url: string) => boolean,
): boolean {
  return frame !== null && frame !== undefined && frame.parent === null && isAppUrl(frame.url);
}
