import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('approved Interview Copilot identity', () => {
  it('keeps the package identity and runtime accent separate', () => {
    const builder = readFileSync('electron-builder.yml', 'utf8');
    const releaseChecklist = readFileSync('docs/07-release-checklist.md', 'utf8');
    const tokens = readFileSync('src/renderer/brand-tokens.css', 'utf8');

    expect(builder).toContain('appId: com.interviewcopilot.app');
    expect(builder).toContain('productName: Interview Copilot');
    expect(builder).toContain('icon: branding/app-icon.ico');
    expect(builder).toContain('installerIcon: branding/app-icon.ico');
    expect(builder).toContain('uninstallerIcon: branding/app-icon.ico');
    expect(existsSync('branding/app-icon.ico')).toBe(true);
    expect(releaseChecklist).toContain('release/Interview Copilot-<version>-x64.exe');
    expect(releaseChecklist).not.toContain('release/Interview CoPilot-<version>-x64.exe');
    expect(tokens).toContain('--brand-primary: #3b82f6');
    expect(tokens).not.toMatch(/--accent\s*:/);
  });

  it('ships the approved optical assets used at small sizes', () => {
    for (const size of [16, 24, 32]) {
      const icon = readFileSync(`src/renderer/assets/icon-${size}.svg`, 'utf8');
      expect(icon).toContain('aria-label="Interview Copilot icon"');
    }
  });
});
