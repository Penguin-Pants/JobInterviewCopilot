import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger, redact } from '../../src/main/logger.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icp-log-'));
}

const OPENAI = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ANTHROPIC = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const DEEPGRAM = 'a'.repeat(40);

/** TC-023 and TC-139: redaction masks keys wherever they surface. */
describe('TC-023 redaction', () => {
  it('masks a key passed as a plain string', () => {
    expect(redact(`using ${OPENAI} now`)).toBe('using [redacted] now');
  });

  it('masks every provider key shape', () => {
    expect(redact(OPENAI)).toBe('[redacted]');
    expect(redact(ANTHROPIC)).toBe('[redacted]');
    expect(redact(DEEPGRAM)).toBe('[redacted]');
  });

  it('masks a key embedded in an Error message and stack', () => {
    const err = new Error(`request failed for ${OPENAI}`);
    const out = redact(err) as { message: string };
    expect(out.message).toBe('request failed for [redacted]');
    expect(JSON.stringify(out)).not.toContain(OPENAI);
  });

  it('masks by field name even when the value has no recognizable shape', () => {
    const out = redact({ apiKey: 'short', authorization: 'Bearer zzz' }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
  });

  it('survives a circular object without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
});

/**
 * TC-139: a key leaked from a path that never crosses IPC is still masked,
 * because redaction lives at the logger rather than at the IPC boundary.
 */
describe('TC-139 redaction covers non-IPC paths', () => {
  it('masks a key from a health-probe error written straight to the log', () => {
    const dir = tmp();
    const logger = new Logger({ dir });
    const probeError = new Error(`probe rejected key ${ANTHROPIC}`);

    logger.error('health probe failed', { credentialId: 'anthropic', err: probeError });
    logger.close();

    const contents = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(contents).not.toContain(ANTHROPIC);
    expect(contents).toContain('[redacted]');
  });
});

/** TC-147: main.log rotates at 5 MB keeping 3 files. */
describe('TC-147 log rotation', () => {
  it('rotates once the file passes 5 MB and keeps at most three', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'main.log'), 'x'.repeat(5 * 1024 * 1024 + 10), 'utf8');

    const logger = new Logger({ dir });
    logger.info('after rotation');
    logger.close();

    expect(existsSync(join(dir, 'main.log.1'))).toBe(true);
    expect(statSync(join(dir, 'main.log')).size).toBeLessThan(1024);
  });
});
