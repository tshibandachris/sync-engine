const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const { openDatabase, applyPulledPage, getCursor, listLocalProducts, saveLocalProduct, getDashboardSummary } = require('./db/client.cjs');
const { pullChanges, pushChanges, enrollDevice: enrollDeviceApi, getDeviceStatus } = require('./sync/api-client.cjs');
const { preparePushBatch, applyPushResponse, getOutboxStatus } = require('./sync/outbox.cjs');
const { DeviceTokenStore } = require('./auth/device-token-store.cjs');
const { DeviceCredentialStore } = require('./auth/device-credential-store.cjs');
const { validateDeviceToken, getMachineFingerprint, getHardwareInfo } = require('./auth/device-enrollment.cjs');
const { generateDeviceKeyPair, createInitialEnrollmentProof } = require('./auth/device-crypto.cjs');
const crypto = require('node:crypto');
const {
  assertTrustedIpcSender,
  validateSearchQuery,
  validateEnrollmentCredentials,
  validateProductInput,
} = require('./security/ipc-security.cjs');

let db;
let windowRef;
let tokenStore;
let credentialStore;
let deviceToken;
let deviceCredential;
let tokenStoreError;
let authState = 'checking';
let authMessage = 'Vérification du stockage sécurisé…';
let status = { state: 'starting', message: 'Initialisation…', productCount: 0, lastCursor: 0, outboxPending: 0, outboxFailed: 0 };

function requireApprovedDeviceCredential() {
  if (authState !== 'ready' || !deviceCredential || deviceCredential.approvalStatus !== 'approved' || deviceCredential.pendingEnrollment) {
    throw new Error('Terminal non approuvé : synchronisation suspendue, données locales conservées.');
  }
  return { deviceId: deviceCredential.deviceId, privateKeyPem: deviceCredential.privateKeyPem };
}

function requireDeviceToken() {
  if (tokenStoreError) throw tokenStoreError;
  if (!deviceToken) {
    throw new Error('Jeton d’appareil absent du stockage sécurisé. Réenrôlez cet appareil avant de synchroniser.');
  }
  return deviceToken;
}

async function initializeDeviceToken() {
  tokenStore = new DeviceTokenStore({ app, safeStorage });
  credentialStore = new DeviceCredentialStore({ app, safeStorage });
  deviceToken = await tokenStore.load();
  deviceCredential = await credentialStore.load();

  // An agent JWT without a device key is not sufficient for protected sync.
  if (deviceToken && deviceCredential?.approvalStatus === 'approved' && !deviceCredential.pendingEnrollment) {
    authState = 'ready';
    authMessage = 'Terminal approuvé ; identité et clé ES256 chargées depuis le stockage sécurisé.';
    return;
  }
  if (deviceToken && deviceCredential?.deviceId && deviceCredential.approvalStatus === 'pending_approval') {
    authState = 'awaiting-approval';
    authMessage = 'Terminal enrôlé ; approbation administrative requise.';
    return;
  }
  authState = 'enrollment-required';
  authMessage = 'Code d’activation et jeton agent requis pour enrôler cette caisse.';
}

function readStatus() {
  const outbox = db ? getOutboxStatus(db) : { pending: status.outboxPending, failed: status.outboxFailed };
  return {
    ...status,
    authState,
    authMessage,
    lastCursor: db ? getCursor(db) : status.lastCursor,
    productCount: db ? Number(db.prepare('SELECT count(*) AS n FROM products WHERE deleted_at IS NULL AND is_active = 1').get().n) : 0,
    outboxPending: outbox.pending,
    outboxFailed: outbox.failed,
    deviceId: deviceCredential?.deviceId ?? null,
    approvalStatus: deviceCredential?.approvalStatus ?? (deviceCredential?.pendingEnrollment ? 'enrollment_pending' : null),
  };
}

async function pullAll() {
  const token = requireDeviceToken();
  let cursor = getCursor(db);
  let pages = 0;
  let productsProcessed = 0;
  while (true) {
    if (++pages > 1000) throw new Error('Pull stopped after 1000 pages; check API pagination.');
    const proof = requireApprovedDeviceCredential();
    const response = await pullChanges({
      baseUrl: process.env.EDEN_SYNC_URL,
      token,
      ...proof,
      lastPulledAt: cursor,
    });
    productsProcessed += applyPulledPage(db, response);
    if (!response.has_more) break;
    if (response.timestamp <= cursor) throw new Error('Pull cursor did not advance while has_more=true.');
    cursor = response.timestamp;
  }
  return { pages, productsProcessed, cursor: getCursor(db) };
}

async function pushPending() {
  const batch = preparePushBatch(db);
  if (!batch) return { sent: false, acknowledged: 0, retained: 0 };
  const proof = requireApprovedDeviceCredential();
  const response = await pushChanges({
    baseUrl: process.env.EDEN_SYNC_URL,
    token: requireDeviceToken(),
    ...proof,
    idempotencyKey: batch.idempotencyKey,
    payload: batch.payload,
  });
  const result = applyPushResponse(db, batch, response);
  console.log(`[sync] push batch=${batch.idempotencyKey}; acknowledged=${result.acknowledged}; retained=${result.retained}; replay=${result.replay}`);
  return { sent: true, ...result };
}

async function doSync() {
  if (status.state === 'syncing') return readStatus();
  if (authState !== 'ready' || !deviceCredential || deviceCredential.approvalStatus !== 'approved') {
    const outbox = getOutboxStatus(db);
    status = { ...status, state: 'pending', message: 'Synchronisation suspendue jusqu’à l’approbation du terminal. ' + outbox.pending + ' opération(s) restent conservées localement.', outboxPending: outbox.pending, outboxFailed: outbox.failed };
    windowRef?.webContents.send('eden:status', readStatus());
    return readStatus();
  }
  status = { ...status, state: 'syncing', message: 'Synchronisation en cours…' };
  windowRef?.webContents.send('eden:status', readStatus());

  try {
    // Pull reference data first (products, staff, sessions) before pushing queued sales.
    const initialPull = await pullAll();
    const push = await pushPending();
    // Pull once more to receive authoritative versions and server-assigned sync sequences.
    const finalPull = push.sent ? await pullAll() : initialPull;
    const outbox = getOutboxStatus(db);
    status = {
      ...status,
      state: outbox.pending > 0 ? 'pending' : 'synced',
      message: `Sync terminée : pull ${finalPull.productsProcessed} produit(s), curseur ${finalPull.cursor}; outbox ${outbox.pending} en attente (${outbox.failed} avec erreur).`,
      lastCursor: finalPull.cursor,
      outboxPending: outbox.pending,
      outboxFailed: outbox.failed,
    };
    console.log(`[sync] OK pullPages=${initialPull.pages + (push.sent ? finalPull.pages : 0)}; products=${initialPull.productsProcessed + (push.sent ? finalPull.productsProcessed : 0)}; cursor=${finalPull.cursor}; outboxPending=${outbox.pending}`);
  } catch (error) {
    const outbox = getOutboxStatus(db);
    status = {
      ...status,
      state: 'pending',
      message: `Synchronisation en attente : ${error.message}. ${outbox.pending} opération(s) conservée(s) dans l’outbox.`,
      outboxPending: outbox.pending,
      outboxFailed: outbox.failed,
    };
    console.error('[sync] failed:', error.message);
  }

  windowRef?.webContents.send('eden:status', readStatus());
  return readStatus();
}

function registerTrustedHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event, windowRef);
    return handler(...args);
  });
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowRef.setTitle('Eden Gestion Desktop');
  const rendererUrl = require('node:url').pathToFileURL(
    path.join(__dirname, 'renderer', 'index.html'),
  ).href;
  windowRef.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  db = openDatabase(app);
  try {
    await initializeDeviceToken();
  } catch (error) {
    tokenStoreError = error;
    authState = 'storage-error';
    authMessage = 'Stockage sécurisé indisponible. La caisse reste bloquée pour protéger le jeton.';
    console.error('[auth] secure device token unavailable:', error.message);
  }

  registerTrustedHandler('eden:get-status', () => readStatus());
  registerTrustedHandler('eden:device:enroll', async (credentials) => {
    try {
      credentials = validateEnrollmentCredentials(credentials);
    } catch (error) {
      return { success: false, error: error.message || 'Paramètres d’enrôlement invalides.' };
    }
    if (tokenStoreError || authState === 'storage-error') {
      return { success: false, error: 'Le stockage sécurisé est indisponible. L’enrôlement est bloqué.' };
    }

    let token;
    try { token = validateDeviceToken(credentials.token); }
    catch (error) { return { success: false, error: error.message || 'JWT agent invalide.' }; }

    try {
      let keyMaterial = deviceCredential;
      if (!keyMaterial || !keyMaterial.privateKeyPem || !keyMaterial.publicKeyPem) {
        const pair = generateDeviceKeyPair();
        keyMaterial = {
          ...pair,
          deviceId: crypto.randomUUID(),
          pendingEnrollment: true,
        };
        await credentialStore.savePending(keyMaterial);
        deviceCredential = await credentialStore.load();
      }

      const fingerprint = getMachineFingerprint(app);
      const hardwareInfo = getHardwareInfo();
      let registration;

      // Recover safely if the server committed enrollment but the response was
      // lost before the local credential could be upgraded from pending state.
      if (deviceCredential?.pendingEnrollment && deviceCredential.deviceId) {
        try {
          registration = await getDeviceStatus({
            baseUrl: process.env.EDEN_SYNC_URL,
            token,
            deviceId: deviceCredential.deviceId,
          });
        } catch (error) {
          if (error.status !== 403 && error.status !== 404) throw error;
        }
      }

      if (!registration) {
        const initialProof = createInitialEnrollmentProof({
          privateKeyPem: keyMaterial.privateKeyPem,
          activationCode: credentials.activationCode.toUpperCase(),
          fingerprint,
          deviceId: keyMaterial.deviceId,
        });
        registration = await enrollDeviceApi({
          baseUrl: process.env.EDEN_SYNC_URL,
          token,
          activationCode: credentials.activationCode.toUpperCase(),
          deviceId: keyMaterial.deviceId,
          deviceName: credentials.deviceName,
          fingerprint,
          hardwareInfo,
          publicKeyPem: keyMaterial.publicKeyPem,
          initialProof,
        });
      }

      if (registration.deviceId !== keyMaterial.deviceId || !registration.tenantId) {
        throw new Error('Le serveur a retourné une identité de terminal incohérente.');
      }
      await credentialStore.save({
        deviceId: registration.deviceId,
        tenantId: registration.tenantId,
        privateKeyPem: keyMaterial.privateKeyPem,
        publicKeyPem: keyMaterial.publicKeyPem,
        thumbprint: keyMaterial.thumbprint,
        algorithm: 'ES256',
        approvalStatus: registration.approvalStatus || 'pending_approval',
      });
      await tokenStore.setToken(token);
      deviceToken = await tokenStore.load();
      deviceCredential = await credentialStore.load();
      if (deviceToken !== token || !deviceCredential?.deviceId) {
        throw new Error('La relecture des identifiants chiffrés a échoué.');
      }

      if (!registration.isActive || ['rejected', 'revoked'].includes(registration.approvalStatus)) {
        authState = 'device-blocked';
        authMessage = registration.approvalStatus === 'rejected'
          ? 'L’enrôlement de ce terminal a été refusé.'
          : 'L’autorisation de ce terminal est révoquée ou désactivée.';
      } else if (registration.approvalStatus === 'approved') {
        deviceCredential = { ...deviceCredential, approvalStatus: 'approved' };
        await credentialStore.save(deviceCredential);
        authState = 'ready';
        authMessage = 'Terminal approuvé ; synchronisation autorisée.';
        void doSync();
      } else {
        authState = 'awaiting-approval';
        authMessage = 'Terminal enrôlé. En attente de validation par votre administrateur.';
      }
      status = { ...status, state: 'pending', message: authMessage, lastCursor: getCursor(db) };
      windowRef?.webContents.send('eden:status', readStatus());
      return { success: true, approvalStatus: authState === 'ready' ? 'approved' : 'pending_approval' };
    } catch (error) {
      // Never clear the SQLite database or the Outbox on enrollment/network failure.
      const outbox = getOutboxStatus(db);
      status = { ...status, state: 'pending', message: 'Enrôlement non finalisé : ' + error.message + '. ' + outbox.pending + ' opération(s) locales conservées.', outboxPending: outbox.pending };
      windowRef?.webContents.send('eden:status', readStatus());
      console.error('[auth] device enrollment failed:', error.message);
      return { success: false, error: error.message || 'Enrôlement impossible.' };
    }
  });

  registerTrustedHandler('eden:device:check-approval', async () => {
    try {
      if (!deviceToken || !deviceCredential?.deviceId) throw new Error('Terminal non enrôlé.');
      const remote = await getDeviceStatus({
        baseUrl: process.env.EDEN_SYNC_URL,
        token: requireDeviceToken(),
        deviceId: deviceCredential.deviceId,
      });
      if (!remote.isActive || ['rejected', 'revoked'].includes(remote.approvalStatus)) {
        authState = 'device-blocked';
        authMessage = remote.approvalStatus === 'rejected'
          ? 'L’enrôlement de ce terminal a été refusé.'
          : 'L’autorisation de ce terminal a été révoquée ou désactivée.';
      } else if (remote.approvalStatus === 'approved') {
        deviceCredential = { ...deviceCredential, approvalStatus: 'approved' };
        await credentialStore.save(deviceCredential);
        authState = 'ready';
        authMessage = 'Terminal approuvé. La synchronisation sécurisée peut reprendre.';
      } else {
        authState = 'awaiting-approval';
        authMessage = 'Le terminal est toujours en attente d’approbation.';
      }
      status = { ...status, state: 'pending', message: authMessage };
      windowRef?.webContents.send('eden:status', readStatus());
      if (authState === 'ready') void doSync();
      return { success: true, approvalStatus: remote.approvalStatus, authState };
    } catch (error) {
      return { success: false, error: error.message || 'Impossible de vérifier le statut du terminal.' };
    }
  });
  registerTrustedHandler('eden:refresh', () => doSync());
  registerTrustedHandler('eden:dashboard', () => getDashboardSummary(db));
  registerTrustedHandler('eden:products:list', (search = '') =>
    listLocalProducts(db, { search: validateSearchQuery(search) }));
  registerTrustedHandler('eden:products:save', (input) => {
    const product = saveLocalProduct(db, validateProductInput(input));
    status = { ...status, outboxPending: getOutboxStatus(db).pending };
    windowRef?.webContents.send('eden:status', readStatus());
    return product;
  });
  createWindow();
  await doSync();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (db) db.close(); });
