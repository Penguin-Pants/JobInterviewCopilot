import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversionError,
  convertToMarkdown,
  runConversionWorker,
  pdfTextToMarkdown,
  sourceFormatFor,
  stripPageSeparators,
  SUPPORTED_EXTENSIONS,
} from '../../src/main/rag/convert.js';
import { extractMarkdown } from '../../src/main/rag/extract.js';
import { buildDocx, buildPdf } from '../fakes/documents.js';

/**
 * TASK-020. The pure half of the converter, plus the failure paths that turn a
 * parser error into a Dashboard sentence (TC-060, TC-063).
 */

describe('sourceFormatFor', () => {
  it('maps the supported extensions, case-insensitively', () => {
    expect(sourceFormatFor('resume.md')).toBe('md');
    expect(sourceFormatFor('resume.MARKDOWN')).toBe('md');
    expect(sourceFormatFor('notes.PDF')).toBe('pdf');
    expect(sourceFormatFor('cv.docx')).toBe('docx');
  });

  it('returns null for anything else, so the watcher ignores it', () => {
    for (const name of ['photo.png', 'notes.rtf', 'archive.zip', 'noextension', '.gitkeep']) {
      expect(sourceFormatFor(name), name).toBeNull();
    }
  });

  it('lists the extensions the import dialog offers', () => {
    expect(SUPPORTED_EXTENSIONS).toEqual(['.md', '.markdown', '.pdf', '.docx']);
  });
});

describe('pdfTextToMarkdown', () => {
  it('rejoins a hard-wrapped sentence', () => {
    const text = 'Built the billing pipeline that\nhandled ten thousand events per second.';
    expect(pdfTextToMarkdown(text)).toBe(
      'Built the billing pipeline that handled ten thousand events per second.',
    );
  });

  it('does not rejoin across a line that already ended a sentence', () => {
    const text = 'First sentence ends here.\nSecond sentence starts here.';
    expect(pdfTextToMarkdown(text)).toBe(
      'First sentence ends here.\n\nSecond sentence starts here.',
    );
  });

  it('restores a paragraph break a PDF cannot carry, so the chunker can soft-split', () => {
    const markdown = pdfTextToMarkdown('One paragraph.\nAnother paragraph.\nA third.');
    expect(markdown.split('\n\n')).toEqual(['One paragraph.', 'Another paragraph.', 'A third.']);
  });

  it('keeps list items as their own lines', () => {
    const markdown = pdfTextToMarkdown('- First item\n- Second item\n- Third item');
    expect(markdown).toBe('- First item\n- Second item\n- Third item');
  });

  it('keeps a heading on its own line rather than folding it into the body', () => {
    expect(pdfTextToMarkdown('# Experience\nAcme Corp')).toBe('# Experience\nAcme Corp');
  });

  it('turns a form feed into a paragraph break and collapses blank runs', () => {
    expect(pdfTextToMarkdown('Page one.\f\n\n\n\nPage two.')).toBe('Page one.\n\nPage two.');
  });

  it('normalizes CRLF', () => {
    expect(pdfTextToMarkdown('One.\r\nTwo.')).toBe('One.\n\nTwo.');
  });
});

describe('stripPageSeparators', () => {
  it('removes pdf-parse page chrome, which is not document content', () => {
    const text = 'Real content.\n-- 1 of 3 --\nMore content.\n--  2 of 3  --\n';
    expect(stripPageSeparators(text)).not.toMatch(/of 3/);
    expect(stripPageSeparators(text)).toContain('Real content.');
    expect(stripPageSeparators(text)).toContain('More content.');
  });

  it('leaves a line that merely looks similar alone', () => {
    expect(stripPageSeparators('Delivered 2 of 3 milestones.')).toBe(
      'Delivered 2 of 3 milestones.',
    );
  });
});

describe('convertToMarkdown failure paths (TC-063)', () => {
  it('reads .md as-is, byte for byte', async () => {
    const source = '# Heading\n\nBody with  odd   spacing.\n';
    const result = await convertToMarkdown(Buffer.from(source), 'md');
    expect(result).toEqual({ markdown: source, extractionQuality: 'native' });
  });

  it('turns a corrupt PDF into a ConversionError with a sentence', async () => {
    const bytes = Buffer.from('%PDF-1.4\nnot actually a pdf');

    await expect(convertToMarkdown(bytes, 'pdf')).rejects.toBeInstanceOf(ConversionError);
    await expect(convertToMarkdown(bytes, 'pdf')).rejects.toThrow(/PDF text extraction failed/);
  }, 30000);

  it('names the scanned-PDF case rather than reporting an empty document', async () => {
    // A valid PDF with no text operators: what a scan without OCR looks like.
    await expect(convertToMarkdown(buildPdf([]), 'pdf')).rejects.toThrow(/no text layer/i);
  }, 30000);

  it('turns a corrupt DOCX into a ConversionError', async () => {
    const bytes = Buffer.from('PK not a real zip');

    await expect(convertToMarkdown(bytes, 'docx')).rejects.toBeInstanceOf(ConversionError);
    await expect(convertToMarkdown(bytes, 'docx')).rejects.toThrow(/DOCX conversion failed/);
  }, 30000);

  it('names an empty DOCX rather than producing an empty document', async () => {
    await expect(convertToMarkdown(buildDocx([{ text: '' }]), 'docx')).rejects.toThrow(
      /contains no text/i,
    );
  }, 30000);
});

describe('a conversion is bounded by its signal (ADR-055)', () => {
  it('stops a DOCX conversion when the signal aborts', async () => {
    const controller = new AbortController();
    const converting = convertToMarkdown(
      buildDocx([{ text: 'Experience', heading: 2 }, { text: 'Acme Corp' }]),
      'docx',
      controller.signal,
    );
    // mammoth took no signal, so the conversion finished anyway after its
    // document had failed, and could overlap a retry of the same file.
    controller.abort();

    await expect(converting).rejects.toThrow(/stopped/);
  }, 30000);

  it('starts no parse for a signal aborted before the parser was ready', async () => {
    const controller = new AbortController();
    controller.abort();

    // The PDF abort listener was added after the parser loaded. An abort in
    // that window does not replay its event, so the parse ran unbounded.
    await expect(
      convertToMarkdown(buildPdf(['# Company', 'Founded in 2015.']), 'pdf', controller.signal),
    ).rejects.toThrow(/stopped/);
  }, 30000);

  it('starts no worker when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = 0;

    await expect(
      runConversionWorker(
        () => {
          spawned += 1;
          return new Worker('', { eval: true });
        },
        Buffer.from('x'),
        'docx',
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ConversionError);
    expect(spawned).toBe(0);
  });

  it('terminates a parse that never yields', async () => {
    // A worker that spins forever and counts, standing in for a parser stuck
    // in a loop. Only terminating the thread stops it.
    const counter = new Int32Array(new SharedArrayBuffer(4));
    const spin = `
      const { workerData } = require('node:worker_threads');
      for (;;) Atomics.add(workerData, 0, 1);
    `;
    const controller = new AbortController();
    const converting = runConversionWorker(
      () => new Worker(spin, { eval: true, workerData: counter }),
      Buffer.from('x'),
      'docx',
      controller.signal,
    );
    await vi.waitFor(() => expect(Atomics.load(counter, 0)).toBeGreaterThan(0));
    controller.abort();
    await expect(converting).rejects.toThrow(/stopped/);

    const settled = Atomics.load(counter, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Atomics.load(counter, 0)).toBe(settled);
  });

  it('reports a worker that exits without a reply as a ConversionError', async () => {
    await expect(
      runConversionWorker(
        () => new Worker('process.exit(3)', { eval: true }),
        Buffer.from('x'),
        'pdf',
      ),
    ).rejects.toThrow(/stopped unexpectedly/);
  });

  it('extracts a DOCX in this thread, for the worker to call', async () => {
    const result = await extractMarkdown(buildDocx([{ text: 'Body text here.' }]), 'docx');
    expect(result.markdown).toContain('Body text here');
    expect(result.extractionQuality).toBe('native');
  }, 30000);
});
