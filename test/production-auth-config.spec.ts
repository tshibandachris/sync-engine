import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const EXPLICIT_PRODUCTION_FILES = new Set([
  '.env.prod.example',
  'docker-compose.prod.yml',
]);
const PROD_FILE = /(^|\/)[^/]*\.prod\.[^/]+$/;
const FORBIDDEN = ['AUTH_ALLOW_SHARED_SECRET', 'JWT_SECRET'];

describe('production configuration excludes shared-secret authentication', () => {
  it('contains neither legacy shared-secret setting in production config files', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    const targets = [...new Set(tracked.filter((path) =>
      EXPLICIT_PRODUCTION_FILES.has(path) || PROD_FILE.test(path),
    ))].sort();

    expect(targets).toContain('.env.prod.example');
    expect(targets).toContain('docker-compose.prod.yml');
    expect(targets.some((path) => path.endsWith('.test.yml') || path.includes('.test.'))).toBe(false);

    for (const path of targets) {
      const content = readFileSync(path, 'utf8');
      for (const setting of FORBIDDEN) {
        expect(content, `${path} must not contain ${setting}`).not.toContain(setting);
      }
    }
  });
});
