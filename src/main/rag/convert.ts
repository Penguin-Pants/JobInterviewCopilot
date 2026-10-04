import { extname } from 'node:path';
import { Worker } from 'node:worker_threads';
import convertWorkerPath from './convert-worker?modulePath';
import {
  ConversionError,
  extractMarkdown,
  type ConversionResult,
  type ConvertReply,
  type ConvertRequest,
  type SourceFormat,
} from './extract.js';

/**
 * Document import and conversion (TASK-020, FR-060, FR-061, ADR-055).
 *
 * `.md` is ingested as-is: no derived file is written and `derivedMarkdownPath`
 * stays null. `.pdf` goes through `pdf-parse` and `.docx` through `mammoth`,
 * each producing Markdown written to `derived/<docId>.md`.
 *
 * Both parsers run in a worker thread, one thread per conversion, and the
 * parsers live in `extract.ts`. A parse in the main thread could not be bounded:
 * mammoth takes no abort signal, and a parse that does not yield also starves
 * the timer that should stop it. On timeout the engine aborts, and the worker
 * is terminated, so no parse keeps running after its document has failed or
 * beside a retry of the same file. It also keeps a long PDF off the thread that
 * answers questions (NFR-001).
 *
 * Both parsers are loaded lazily, inside the worker, at the first conversion of
 * that format, so a user who only ever drops Markdown in never loads them.
 */

export {
  ConversionError,
  pdfTextToMarkdown,
  stripPageSeparators,
  type ConversionResult,
  type ExtractionQuality,
  type SourceFormat,
} from './extract.js';

const EXTENSIONS: Record<string, SourceFormat> = {
  '.md': 'md',
  '.markdown': 'md',
  '.pdf': 'pdf',
  '.docx': 'docx',
};

/** Extensions the knowledge base watcher and the import dialog accept (FR-060). */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSIONS);

/**
 * Map a file name to its source format (FR-060).
 *
 * @returns null for an unsupported extension, so the watcher can ignore a file
 * rather than creating a document record that can only ever fail.
 */
export function sourceFormatFor(fileName: string): SourceFormat | null {
  return EXTENSIONS[extname(fileName).toLowerCase()] ?? null;
}

/** Starts one conversion worker. Injected by a test that needs a worker it controls. */
export type SpawnConvertWorker = () => Worker;

const spawnConvertWorker: SpawnConvertWorker = () => new Worker(convertWorkerPath);

/**
 * Produce Markdown from a source document's bytes (FR-060, FR-061, TC-060, TC-062).
 *
 * Takes the bytes rather than a path. The caller already read the file to hash
 * it, and a second read here could see a different file than the one hashed,
 * so the cache key would describe content that was never converted.
 *
 * `signal` stops the conversion: its worker is terminated (ADR-055). A signal
 * that is already aborted starts nothing.
 *
 * Throws {@link ConversionError} rather than a raw parser error, so a Dashboard
 * row shows a sentence instead of a stack frame. The caller turns that into
 * `state: 'error'`; this function never decides a document's state (TC-063).
 */
export async function convertToMarkdown(
  bytes: Buffer,
  format: SourceFormat,
  signal?: AbortSignal,
): Promise<ConversionResult> {
  if (signal?.aborted) throw stoppedError();
  // Markdown needs no parser, and reading it as UTF-8 cannot hang.
  if (format === 'md') return extractMarkdown(bytes, format);
  return runConversionWorker(spawnConvertWorker, bytes, format, signal);
}

/**
 * Run one conversion in a worker thread and stop the thread when it is done
 * (ADR-055).
 *
 * The promise settles only once the thread has been terminated, after a reply
 * or after an abort, so a caller that sees it settle knows no parse is still
 * running. The thread is terminated after a reply too, because the worker
 * keeps its message port open.
 *
 * The signal is checked, and its listener added, in the same synchronous step
 * that starts the thread. An abort before that point does not replay its
 * event, so a listener added after an await would miss it, and the parse would
 * start after its document had already failed.
 */
export function runConversionWorker(
  spawn: SpawnConvertWorker,
  bytes: Buffer,
  format: SourceFormat,
  signal?: AbortSignal,
): Promise<ConversionResult> {
  return new Promise<ConversionResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(stoppedError());
      return;
    }
    const worker = spawn();
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate().then(settle, settle);
    };
    const onAbort = (): void => finish(() => reject(stoppedError()));
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.once('message', (reply: ConvertReply) =>
      finish(() => {
        if (reply.ok) resolve(reply.result);
        else
          reject(reply.conversion ? new ConversionError(reply.message) : new Error(reply.message));
      }),
    );
    // A raw error, not a ConversionError: the engine logs it and the row says
    // only "Conversion failed.", because a load failure can name a path.
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) =>
      finish(() =>
        reject(new ConversionError(`The converter stopped unexpectedly (code ${code}).`)),
      ),
    );

    const request: ConvertRequest = { bytes, format };
    worker.postMessage(request);
  });
}

function stoppedError(): ConversionError {
  return new ConversionError('Conversion was stopped.');
}
