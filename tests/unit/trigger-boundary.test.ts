/**
 * TASK-060, TC-182. `CMP-05` must not call an LLM provider directly
 * (`02-architecture.md` section 1).
 *
 * A static check against the source, the technique `TC-042` and `TC-096`
 * already use for their own module-boundary claims: the claim is about what
 * the module *imports*, not about what one code path happened to do on the day
 * the test ran. A runtime test could only ever prove that today's trigger did
 * not reach a provider.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(repoRoot, 'src', 'main', 'ai', 'trigger.ts'), 'utf8');

/** Every `import ... from '<specifier>'` in the file, as {specifier, names}. */
function imports(): { specifier: string; names: string[] }[] {
  const out: { specifier: string; names: string[] }[] = [];
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+'([^']+)'/g)) {
    const clause = match[1] ?? '';
    const specifier = match[2] ?? '';
    const names = [...clause.matchAll(/[A-Za-z_$][\w$]*/g)]
      .map((m) => m[0] ?? '')
      .filter((name) => name !== 'type' && name !== 'import');
    out.push({ specifier, names });
  }
  return out;
}

describe('TC-182 trigger.ts never imports an LLM adapter', () => {
  const graph = imports();

  it('reads at least the two imports the module is known to have', () => {
    // A regex that matched nothing would make every assertion below vacuous.
    expect(graph.length).toBeGreaterThanOrEqual(2);
    expect(graph.map((i) => i.specifier)).toContain('./actionability.js');
  });

  it('imports neither LlmProvider nor classifyWithLlm, under any specifier', () => {
    const imported = graph.flatMap((i) => i.names);
    expect(imported).not.toContain('LlmProvider');
    expect(imported).not.toContain('classifyWithLlm');
  });

  it('takes only the heuristic half of actionability.ts', () => {
    const fromActionability = graph
      .filter((i) => i.specifier === './actionability.js')
      .flatMap((i) => i.names)
      .sort();
    expect(fromActionability).toEqual(['ActionabilityVerdict', 'classifyHeuristically']);
  });

  it('imports nothing from the LLM module or any provider adapter at all', () => {
    const specifiers = graph.map((i) => i.specifier);
    expect(specifiers.filter((s) => /llm/i.test(s))).toEqual([]);
    expect(specifiers.filter((s) => s.includes('/stt/') || s.includes('/llm/'))).toEqual([]);
  });

  /**
   * The names could also arrive through a bare mention rather than an import
   * clause -- a dynamic `import()`, or a `require`. Neither belongs here, and
   * the plain text check is what keeps the assertions above from being
   * sidestepped.
   */
  it('mentions neither name anywhere in the file, by any route', () => {
    expect(source).not.toMatch(/\bLlmProvider\b/);
    expect(source).not.toMatch(/\bclassifyWithLlm\b/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});
