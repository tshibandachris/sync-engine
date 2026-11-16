import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const electronDir = path.join(root, 'electron-app');
const requireElectron = createRequire(path.join(electronDir, 'package.json'));
const electronBinary = requireElectron('electron');
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'eden-e2e-electron-'));
const debugPort = 9222;
const args = [
  '.',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userDataDir}`,
];

let stdout = '';
let stderr = '';
const child = spawn(electronBinary, args, {
  cwd: electronDir,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    XDG_CONFIG_HOME: userDataDir,
    XDG_CACHE_HOME: userDataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let page;
let failure;
try {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        page = targets.find((target) =>
          target.type === 'page' &&
          typeof target.url === 'string' &&
          target.url.endsWith('/renderer/index.html')
        );
        if (page) break;
      }
    } catch {
      // Chromium's remote-debugging endpoint is not ready yet.
    }
    await sleep(250);
  }
  if (!page) throw new Error('Electron renderer did not become available through the local DevTools endpoint.');
  console.log('E2E_ELECTRON_WINDOW_READY');
  console.log(`renderer_url=${page.url}`);
  console.log(`renderer_title=${page.title || '(empty)'}`);
} catch (error) {
  failure = error;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      sleep(5_000).then(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }),
    ]);
  }
  await rm(userDataDir, { recursive: true, force: true });
}

if (failure) {
  process.stderr.write(stdout);
  process.stderr.write(stderr);
  throw failure;
}
