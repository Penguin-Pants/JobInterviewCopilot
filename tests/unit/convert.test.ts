import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConversionError,
  convertToMarkdown,
  pdfTextToMarkdown,
  sourceFormatFor,
  stripPageSeparators,
  SUPPORTED_EXTENSIONS,
} from '../../src/main/rag/convert.js';
import { buildDocx, buildPdf } from '../fakes/documents.js';

/**
 * TASK-020. The pure half of the converter, plus the failure paths that turn a
 * parser error into a Dashboard sentence (TC-060, TC-063).
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icp-convert-'));
}

function write(name: string, contents: string | Buffer): string {
  const path = join(tmp(), name);
  writeFileSync(path, contents);
  return path;
}

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
    const result = await convertToMarkdown(write('a.md', source), 'md');
    expect(result).toEqual({ markdown: source, extractionQuality: 'native' });
  });

  it('turns a corrupt PDF into a ConversionError with a sentence', async () => {
    const path = write('broken.pdf', Buffer.from('%PDF-1.4\nnot actually a pdf'));

    await expect(convertToMarkdown(path, 'pdf')).rejects.toBeInstanceOf(ConversionError);
    await expect(convertToMarkdown(path, 'pdf')).rejects.toThrow(/PDF text extraction failed/);
  }, 30000);

  it('names the scanned-PDF case rather than reporting an empty document', async () => {
    // A valid PDF with no text operators: what a scan without OCR looks like.
    const path = write('scanned.pdf', buildPdf([]));

    await expect(convertToMarkdown(path, 'pdf')).rejects.toThrow(/no text layer/i);
  }, 30000);

  it('turns a corrupt DOCX into a ConversionError', async () => {
    const path = write('broken.docx', Buffer.from('PK not a real zip'));

    await expect(convertToMarkdown(path, 'docx')).rejects.toBeInstanceOf(ConversionError);
    await expect(convertToMarkdown(path, 'docx')).rejects.toThrow(/DOCX conversion failed/);
  }, 30000);

  it('names an empty DOCX rather than producing an empty document', async () => {
    const path = write('empty.docx', buildDocx([{ text: '' }]));

    await expect(convertToMarkdown(path, 'docx')).rejects.toThrow(/contains no text/i);
  }, 30000);

  it('rejects a missing file rather than returning empty Markdown', async () => {
    await expect(convertToMarkdown(join(tmp(), 'nope.md'), 'md')).rejects.toThrow();
  });
});
