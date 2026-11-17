import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'test/eden-gestion.e2e.spec.ts',
    '--reporter=verbose',
  ],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, E2E_FORCE_SETUP_FAILURE: '1' },
    maxBuffer: 16 * 1024 * 1024,
  },
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);

if (result.error) {
  throw result.error;
}
if (result.status === 0) {
  throw new Error('Expected the injected beforeAll failure to make the child Vitest run fail.');
}
if (!output.includes('T-B03-2_EXTERNAL_CLEANUP_VERIFIED')) {
  throw new Error('The child run did not emit the external cleanup verification marker.');
}

console.log('T-B03-2 parent runner: observed the failing beforeAll process and its post-cleanup proof.');
