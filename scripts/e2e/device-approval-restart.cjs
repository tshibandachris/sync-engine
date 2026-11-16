'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const ELECTRON_DIR = path.join(REPO_ROOT, 'electron-app');
const STAFF_ID = '00000000-0000-4000-8000-000000000333';
const DEVICE_ID = '00000000-0000-4000-8000-000000000111';
const TENANT_ID = '00000000-0000-4000-8000-000000000222';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedWithRealElectron(appDataPath) {
  const { app, safeStorage } = require('electron');
  app.setPath('appData', appDataPath);
  await app.whenReady();

  let db;
  try {
    const backend = safeStorage.getSelectedStorageBackend();
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'Electron safeStorage must be available');
    assert.equal(backend, 'gnome_libsecret', 'B-04 requires the real GNOME libsecret OS keyring backend');

    const { DeviceTokenStore } = require(path.join(ELECTRON_DIR, 'electron/auth/device-token-store.cjs'));
    const { DeviceCredentialStore } = require(path.join(ELECTRON_DIR, 'electron/auth/device-credential-store.cjs'));
    const { DeviceApprovalStateStore } = require(path.join(ELECTRON_DIR, 'electron/auth/device-approval-state-store.cjs'));
    const { generateDeviceKeyPair } = require(path.join(ELECTRON_DIR, 'electron/auth/device-crypto.cjs'));
    const { openDatabase } = require(path.join(ELECTRON_DIR, 'electron/db/client.cjs'));

    const token = [
      Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'eden-b04-e2e', exp: 4102444800 })).toString('base64url'),
      'AA',
    ].join('.');
    const keyPair = generateDeviceKeyPair();
    const credential = {
      deviceId: DEVICE_ID,
      tenantId: TENANT_ID,
      privateKeyPem: keyPair.privateKeyPem,
      publicKeyPem: keyPair.publicKeyPem,
      thumbprint: keyPair.thumbprint,
      algorithm: 'ES256',
    };
    const decision = {
      deviceId: DEVICE_ID,
      tenantId: TENANT_ID,
      approvalStatus: 'approved',
      isActive: true,
      hasActiveCredential: true,
      decisionVersion: crypto.randomUUID(),
      confirmedAt: new Date().toISOString(),
    };

    await new DeviceTokenStore({ app, safeStorage }).setToken(token);
    await new DeviceCredentialStore({ app, safeStorage }).save(credential);
    await new DeviceApprovalStateStore({ app, safeStorage }).save(decision);

    db = openDatabase(app);
    db.prepare(`
      INSERT INTO staff (id, display_name, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(STAFF_ID, 'B-04 E2E Cashier', 'cashier', Date.now(), Date.now());

    console.log(`B04_SEED_OK backend=${backend} device=${DEVICE_ID} tenant=${TENANT_ID}`);
  } finally {
    if (db) db.close();
    app.quit();
  }
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForRenderer(port, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron app exited before renderer startup (code=${child.exitCode}, signal=${child.signalCode}).\n${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) =>
          target.type === 'page' &&
          typeof target.url === 'string' &&
          target.url.endsWith('/renderer/index.html')
        );
        if (page) return page;
      }
    } catch {
      // DevTools is not ready yet.
    }
    await delay(250);
  }
  throw new Error(`Electron renderer did not become available.\n${output()}`);
}

async function connectDevTools(webSocketUrl) {
  assert.equal(typeof WebSocket, 'function', 'Node.js WebSocket support is required for the Electron integration test');
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message || 'DevTools command failed.'));
    else callbacks.resolve(message.result);
  });

  return {
    socket,
    evaluate(expression) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        }));
      }).then((result) => {
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result?.value;
      });
    },
  };
}

async function runParent() {
  const electronBinary = createRequire(path.join(ELECTRON_DIR, 'package.json'))('electron');
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eden-b04-electron-restart-'));
  const appDataPath = path.join(temporaryRoot, 'app-data');
  const profilePath = path.join(temporaryRoot, 'profile');
  await fs.mkdir(appDataPath, { recursive: true });
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: appDataPath,
    XDG_CACHE_HOME: path.join(temporaryRoot, 'cache'),
    EDEN_SYNC_URL: 'http://127.0.0.1:1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  };

  let appProcess;
  let devTools;
  let stdout = '';
  let stderr = '';
  const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;

  try {
    const seed = spawnSync(electronBinary, [
      '--password-store=gnome-libsecret',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      __filename,
      'seed',
      appDataPath,
    ], { cwd: ELECTRON_DIR, env, encoding: 'utf8', timeout: 30_000 });
    if (seed.error) throw seed.error;
    assert.equal(seed.status, 0, `First Electron process could not persist the approved state.\n${seed.stdout}\n${seed.stderr}`);
    assert.match(seed.stdout, /B04_SEED_OK backend=gnome_libsecret/);

    const port = await getFreePort();
    appProcess = spawn(electronBinary, [
      '--password-store=gnome-libsecret',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '.',
      `--user-data-dir=${profilePath}`,
    ], { cwd: ELECTRON_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    appProcess.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    appProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const page = await waitForRenderer(port, appProcess, output);
    devTools = await connectDevTools(page.webSocketDebuggerUrl);

    let status;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      status = await devTools.evaluate('window.eden.getStatus()');
      if (status?.deviceTrustState === 'approved' && status?.canOperateLocally === true) break;
      await delay(300);
    }

    assert.equal(status?.agentAuthState, 'authenticated', 'the stored agent token must survive process restart');
    assert.equal(status?.deviceCredentialState, 'available', 'the encrypted ES256 credential must survive process restart');
    assert.equal(status?.deviceTrustState, 'approved', 'the last confirmed server approval must be restored');
    assert.equal(status?.canOperateLocally, true, 'the local POS write permission must be restored');
    assert.equal(status?.serverHasActiveCredential, true, 'the cached active credential decision must be restored');
    assert.equal(status?.deviceApprovalStateError, null, 'the encrypted approval decision must decrypt without error');

    const session = await devTools.evaluate(
      `window.eden.openCashSession({ staffId: "${STAFF_ID}", openingAmount: 0, terminalLabel: "B04 restart" })`
    );
    assert.equal(session?.status, 'open', 'the real POS IPC write must open a local cash session while the API is offline');
    assert.ok(session?.id, 'the local cash session must have a persisted identifier');

    const finalStatus = await devTools.evaluate('window.eden.getStatus()');
    assert.equal(finalStatus.deviceTrustState, 'approved');
    assert.equal(finalStatus.canOperateLocally, true);
    assert.ok(finalStatus.outboxPending >= 1, 'the offline POS operation must remain queued locally');

    console.log(JSON.stringify({
      scenario: 'B-04-real-electron-safeStorage-process-restart',
      firstProcess: 'saved token, ES256 credential and approved decision',
      secondProcess: 'fresh Electron application process',
      safeStorageBackend: 'gnome_libsecret',
      apiEndpoint: 'http://127.0.0.1:1 (intentionally unavailable)',
      restoredTrustState: finalStatus.deviceTrustState,
      localPosWritePermission: finalStatus.canOperateLocally,
      cashSessionCreated: true,
      outboxPending: finalStatus.outboxPending,
      result: 'PASS',
    }, null, 2));
  } finally {
    if (devTools?.socket.readyState === WebSocket.OPEN) devTools.socket.close();
    if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
      appProcess.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => appProcess.once('close', resolve)),
        delay(5_000).then(() => {
          if (appProcess.exitCode === null && appProcess.signalCode === null) appProcess.kill('SIGKILL');
        }),
      ]);
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.versions.electron && process.argv[2] === 'seed') {
  seedWithRealElectron(process.argv[3]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
    const { app } = require('electron');
    app.exit(1);
  });
} else if (require.main === module) {
  runParent().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
