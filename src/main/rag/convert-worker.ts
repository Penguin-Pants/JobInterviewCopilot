import { parentPort } from 'node:worker_threads';
import {
  ConversionError,
  extractMarkdown,
  type ConvertReply,
  type ConvertRequest,
} from './extract.js';

/**
 * The conversion worker thread (TASK-020, ADR-055).
 *
 * Converts one document and posts one {@link ConvertReply}. `convert.ts`
 * terminates the thread after the reply, or earlier when the conversion times
 * out. Terminating stops the parser even in a loop that never yields, which an
 * abort signal inside the main thread could not do.
 *
 * Bundled as its own file by electron-vite's `?modulePath` import, and by the
 * test config's equivalent, so it imports only `extract.ts` and never the code
 * that starts it.
 */
parentPort?.once('message', (request: ConvertRequest) => {
  const bytes = Buffer.from(
    request.bytes.buffer,
    request.bytes.byteOffset,
    request.bytes.byteLength,
  );
  extractMarkdown(bytes, request.format).then(
    (result) => {
      const reply: ConvertReply = { ok: true, result };
      parentPort?.postMessage(reply);
    },
    (err: unknown) => {
      const reply: ConvertReply = {
        ok: false,
        conversion: err instanceof ConversionError,
        message: err instanceof Error ? err.message : String(err),
      };
      parentPort?.postMessage(reply);
    },
  );
});
