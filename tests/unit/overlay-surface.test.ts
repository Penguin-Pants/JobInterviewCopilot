/**
 * TASK-032. The overlay's IPC surface, and the readiness gate in front of it.
 *
 * TC-096 is a static check against the preload source, because the claim is
 * about what the surface *is*, not about what one code path happens to send.
 * A runtime test could only ever prove that today's code did not send an error.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUSH_CHANNEL_NAMES, pushChannels, type PushChannel } from '../../src/shared/ipc.js';
import { OverlayGate, isGatedChannel, type GatedMessage } from '../../src/main/overlay-gate.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const preload = readFileSync(join(repoRoot, 'src', 'preload', 'overlay.ts'), 'utf8');

/**
 * The field names of an object schema.
 *
 * Read through `def` rather than a typed accessor because the value here is a
 * union over every push channel, and most of them are object schemas while a
 * few are not. A schema with no shape contributes no field, which is the right
 * answer for this check.
 */
function objectFields(schema: unknown): string[] {
  const def = (schema as { def?: { shape?: Record<string, unknown> } }).def;
  return Object.keys(def?.shape ?? {});
}

/** The values of an enum field on an object schema. */
function enumValues(schema: unknown, field: string): string[] {
  const shape = (schema as { def?: { shape?: Record<string, unknown> } }).def?.shape ?? {};
  const entries = (shape[field] as { def?: { entries?: Record<string, string> } } | undefined)?.def
    ?.entries;
  return Object.keys(entries ?? {});
}

/** The channel names inside a `const NAME: readonly ...[] = [ ... ]` literal. */
function allowlist(name: string): string[] {
  const match = new RegExp(`const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(preload);
  expect(match, `${name} is missing from the overlay preload`).toBeTruthy();
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

/** TC-096: no channel reachable from the overlay can carry an error to it. */
describe('TC-096 no overlay error channel', () => {
  const push = allowlist('ALLOWED_PUSH');
  const invoke = allowlist('ALLOWED_INVOKE');

  it('exposes exactly the channels the overlay needs, and no more', () => {
    expect(push.sort()).toEqual(
      [
        'overlay:consent',
        'overlay:mode',
        'overlay:theme',
        'state:session',
        'suggestion:begin',
        'suggestion:end',
        'suggestion:line',
      ].sort(),
    );
    expect(invoke.sort()).toEqual(
      ['consent:dismiss', 'overlay:ready', 'overlay:savePosition'].sort(),
    );
  });

  it('no allowed push channel has a field that can carry a failure', () => {
    for (const channel of push) {
      const spec = pushChannels[channel as PushChannel];
      expect(spec, `${channel} is not a declared push channel`).toBeTruthy();
      // Probed rather than read off the schema type: every allowed channel is
      // an object schema, and a field the overlay must never have is one that
      // survives parsing. `error` is the one FR-076 forbids by name.
      const probe = spec.payload.safeParse({ error: 'boom' });
      expect(probe.success && 'error' in probe.data, channel).toBe(false);
      expect(objectFields(spec.payload).join(','), channel).not.toMatch(
        /error|reason|failure|warning/i,
      );
    }
  });

  it('the failure-carrying channels exist and are all withheld from the overlay', () => {
    // These are how a failure is reported (FR-076, FR-100): the Dashboard
    // badge, never the overlay. Naming them makes the exclusion deliberate
    // rather than incidental.
    const dashboardOnly: PushChannel[] = [
      'state:providers',
      'usage:warning',
      'rag:progress',
      'model:download',
      'notice:captureFidelity',
    ];
    for (const channel of dashboardOnly) {
      expect(PUSH_CHANNEL_NAMES).toContain(channel);
      expect(push).not.toContain(channel);
    }
  });

  it('the suggestion end status has no error value', () => {
    // A generation that failed reports `cancelled`, which clears the card. The
    // overlay has two states, idle and suggestions, and no third (FR-076).
    expect(enumValues(pushChannels['suggestion:end'].payload, 'status')).toEqual([
      'complete',
      'cancelled',
      'nonconforming',
    ]);
  });
});

/** FR-008, ADR-016: suggestions are buffered until the overlay reports ready. */
describe('the overlay readiness gate', () => {
  function gate(): { sent: GatedMessage[]; gate: OverlayGate } {
    const sent: GatedMessage[] = [];
    return { sent, gate: new OverlayGate((m) => sent.push(m)) };
  }

  function begin(generationId: string): GatedMessage {
    return {
      channel: 'suggestion:begin',
      payload: { generationId, cardId: `card-${generationId}`, question: 'q' },
    };
  }

  function line(generationId: string, text: string, index = 0): GatedMessage {
    return {
      channel: 'suggestion:line',
      payload: { generationId, cardId: `card-${generationId}`, line: text, index },
    };
  }

  function end(generationId: string): GatedMessage {
    return { channel: 'suggestion:end', payload: { generationId, status: 'cancelled' } };
  }

  it('buffers rather than drops before overlay:ready, then flushes in order', () => {
    const g = gate();
    g.gate.send(begin('gen-1'));
    g.gate.send(line('gen-1', 'first'));
    expect(g.sent).toHaveLength(0);
    expect(g.gate.pending).toBe(2);

    g.gate.noteReady();
    expect(g.sent.map((m) => m.channel)).toEqual(['suggestion:begin', 'suggestion:line']);
    expect(g.gate.pending).toBe(0);
  });

  it('passes straight through once ready', () => {
    const g = gate();
    g.gate.noteReady();
    g.gate.send(begin('gen-1'));
    expect(g.sent).toHaveLength(1);
  });

  it('holds one generation: a second discards the first (FR-008, FR-054)', () => {
    const g = gate();
    g.gate.send(begin('gen-1'));
    g.gate.send(line('gen-1', 'stale'));
    g.gate.send(begin('gen-2'));
    g.gate.send(line('gen-2', 'fresh'));

    g.gate.noteReady();
    expect(g.sent).toHaveLength(2);
    expect(g.sent.every((m) => m.payload.generationId === 'gen-2')).toBe(true);
  });

  /**
   * Regressions found by the Codex review on the pull request.
   */
  it('ignores a cancelled generation\u2019s late end rather than dropping its replacement', () => {
    const g = gate();
    g.gate.send(begin('gen-1'));
    g.gate.send(line('gen-1', 'stale'));

    // A newer turn cancels gen-1 and starts gen-2. The two run concurrently, so
    // gen-1's end arrives *after* gen-2's begin.
    g.gate.send(begin('gen-2'));
    g.gate.send(end('gen-1'));
    g.gate.send(line('gen-2', 'fresh'));
    g.gate.send(end('gen-2'));

    g.gate.noteReady();
    // The replacement's begin has to survive, or its lines arrive with no card
    // to render them on.
    expect(g.sent.map((m) => [m.channel, m.payload.generationId])).toEqual([
      ['suggestion:begin', 'gen-2'],
      ['suggestion:line', 'gen-2'],
      ['suggestion:end', 'gen-2'],
    ]);
  });

  it('ignores a line whose begin never arrived', () => {
    const g = gate();
    g.gate.noteReady();
    g.gate.send(line('gen-9', 'orphan'));
    expect(g.sent).toHaveLength(0);
  });

  it('replays the whole card to a rebuilt overlay (ADR-015)', () => {
    const g = gate();
    g.gate.noteReady();
    g.gate.send(begin('gen-1'));
    g.gate.send(line('gen-1', 'first'));
    expect(g.sent).toHaveLength(2);

    // A translucency change rebuilds the window mid-generation. The new
    // renderer never saw the begin, so the tail alone cannot be rendered.
    g.gate.noteClosed();
    g.gate.send(line('gen-1', 'second', 1));
    expect(g.sent).toHaveLength(2);

    g.gate.noteReady();
    expect(g.sent.slice(2).map((m) => m.channel)).toEqual([
      'suggestion:begin',
      'suggestion:line',
      'suggestion:line',
    ]);
  });

  it('reports what the current renderer has not been sent', () => {
    const g = gate();
    g.gate.send(begin('gen-1'));
    g.gate.send(line('gen-1', 'first'));
    expect(g.gate.pending).toBe(2);
    expect(g.gate.currentGenerationId).toBe('gen-1');

    g.gate.noteReady();
    expect(g.gate.pending).toBe(0);
  });

  it('a second overlay:ready is a no-op rather than a second flush', () => {
    const g = gate();
    g.gate.send(begin('gen-1'));
    g.gate.noteReady();
    g.gate.noteReady();
    expect(g.sent).toHaveLength(1);
    expect(g.gate.isReady).toBe(true);
  });

  it('a rebuilt overlay closes the gate again', () => {
    const g = gate();
    g.gate.noteReady();
    g.gate.noteClosed();
    expect(g.gate.isReady).toBe(false);

    g.gate.send(begin('gen-1'));
    expect(g.sent).toHaveLength(0);
  });

  it('gates exactly the three suggestion channels', () => {
    expect(isGatedChannel('suggestion:begin')).toBe(true);
    expect(isGatedChannel('suggestion:line')).toBe(true);
    expect(isGatedChannel('suggestion:end')).toBe(true);
    expect(isGatedChannel('overlay:theme')).toBe(false);
  });
});
