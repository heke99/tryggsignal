import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const appRoot = resolve(repoRoot, 'apps/platform-web');

/**
 * Regression guard. Next.js only compiles the proxy when the file sits beside the
 * `app` directory — with a `src` directory that means `src/proxy.ts`, not the
 * package root. A misplaced file produces no build error at all: the app builds,
 * deploys, and then serves every hostname without tenant resolution, so `/`
 * falls through to the root page and every request looks like an unknown domain.
 * That happened in production once; this test makes it impossible to repeat.
 */
describe('platform-web proxy placement', () => {
  it('lives next to the app directory, not at the package root', () => {
    expect(existsSync(resolve(appRoot, 'src/app'))).toBe(true);
    expect(existsSync(resolve(appRoot, 'src/proxy.ts'))).toBe(true);
    expect(existsSync(resolve(appRoot, 'proxy.ts'))).toBe(false);
  });

  it('exports a function named proxy, which is the name Next.js looks for', () => {
    const source = readFileSync(resolve(appRoot, 'src/proxy.ts'), 'utf8');
    expect(source).toMatch(/export\s+async\s+function\s+proxy\s*\(/);
  });
});
