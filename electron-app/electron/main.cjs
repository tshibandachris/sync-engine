const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { openDatabase, applyPulledPage, getCursor, listLocalProducts, saveLocalProduct, getDashboardSummary } = require('./db/client.cjs');
const { pullChanges, pushChanges } = require('./sync/api-client.cjs');
const { preparePushBatch, applyPushResponse, getOutboxStatus } = require('./sync/outbox.cjs');
const { DeviceTokenStore } = require('./auth/device-token-store.cjs');
const { DeviceCredentialStore } = require('./auth/device-credential-store.cjs');
const { DeviceEnrollmentAttemptStore } = require('./auth/device-enrollment-attempt-store.cjs');
const { deriveDeviceTrustState, canAccessLocalPOS, canRunSync } = require('./auth/device-state.cjs');
const { DeviceStatusService } = require('./auth/device-status.cjs');
const { generateDeviceKeyPair, createInitialEnrollmentProof } = require('./auth/device-crypto.cjs');
const { enrollDevice: enrollDeviceWithProof } = require('./auth/device-enrollment-client.cjs');
const { validateDeviceToken } = require('./auth/device-enrollment.cjs');
const {
  assertTrustedIpcSender,
  validateSearchQuery,
  validateEnrollmentCredentials,
  validateDeviceEnrollmentInput,
  validateProductInput,
} = require('./security/ipc-security.cjs');

let db;
let windowRef;
let tokenStore;
let deviceToken;
let tokenStoreError;
let credentialStore;
let enrollmentAttemptStore;
let pendingEnrollmentAttempt = null;
let enrollmentAttemptError = null;
let deviceCredential = null;
let deviceCredentialError = null;
let deviceStatusService = null;
let serverHasActiveCredential = false;
// The encrypted device credential is the only source of the private key used for request proofs.
let deviceProofReady = false;
let agentAuthState = 'unauthenticated';
let deviceTrustState = 'unregistered';
let syncState = 'blocked_unregistered';
let authState = 'checking';
let authMessage = 'Vérification du stockage sécurisé…';
let status = { state: 'starting', message: 'Initialisation…', productCount: 0, lastCursor: 0, outboxPending: 0, outboxFailed: 0 };

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
  enrollmentAttemptStore = new DeviceEnrollmentAttemptStore({ app, safeStorage });
  deviceToken = await tokenStore.load();
  try {
    deviceCredential = await credentialStore.load();
    deviceTrustState = deriveDeviceTrustState(deviceCredential);
    deviceProofReady = Boolean(deviceCredential?.deviceId && deviceCredential?.privateKeyPem && deviceCredential?.algorithm === 'ES256');
  } catch (error) {
    deviceCredentialError = error;
    deviceProofReady = false;
    deviceTrustState = 'unregistered';
    console.error('[device] encrypted credential unavailable; sync remains fail-closed:', error.message);
  }
  try {
    pendingEnrollmentAttempt = await enrollmentAttemptStore.load();
    if (deviceCredential?.deviceId && pendingEnrollmentAttempt) {
      await enrollmentAttemptStore.clear();
      pendingEnrollmentAttempt = null;
    }
  } catch (error) {
    enrollmentAttemptError = error;
    console.error('[device] encrypted pending enrollment unavailable; new enrollment is blocked:', error.message);
  }
  syncState = deviceTrustState === 'awaiting_approval' ? 'blocked_unapproved' : 'blocked_unregistered';

  // Environment-based bootstrap is strictly for unpackaged local development.
  // Packaged production builds never read EDEN_SYNC_TOKEN from process.env.
  if (!deviceToken && !app.isPackaged) {
    const developmentToken = process.env.EDEN_SYNC_TOKEN;
    if (developmentToken) {
      const validated = validateDeviceToken(developmentToken);
      await tokenStore.setToken(validated);
      deviceToken = await tokenStore.load();
    }
  }

  if (deviceToken) {
    agentAuthState = 'authenticated';
    authState = 'ready';
    authMessage = 'Jeton d’appareil chargé depuis le stockage sécurisé.';
    return;
  }

  agentAuthState = 'unauthenticated';
  authState = 'enrollment-required';
  authMessage = 'Cette caisse doit être enrôlée avant de synchroniser.';
}


function getDeviceHardwareInfo() {
  return {
    hostname: os.hostname().slice(0, 255),
    platform: os.platform().slice(0, 40),
    arch: os.arch().slice(0, 40),
    osRelease: os.release().slice(0, 100),
  };
}

function getDeviceFingerprint(hardwareInfo) {
  // Stable host fingerprint; no serial number or hardware secret is collected.
  return crypto.createHash('sha256')
    .update([hardwareInfo.hostname, hardwareInfo.platform, hardwareInfo.arch, hardwareInfo.osRelease].join('\0'), 'utf8')
    .digest('hex');
}

function readStatus() {
  const outbox = db ? getOutboxStatus(db) : { pending: status.outboxPending, failed: status.outboxFailed };
  return {
    ...status,
    authState,
    authMessage,
    agentAuthState,
    deviceTrustState,
    syncState,
    deviceId: deviceCredential?.deviceId || null,
    deviceThumbprint: deviceCredential?.thumbprint || null,
    deviceCredentialError: deviceCredentialError?.message || null,
    pendingEnrollment: Boolean(pendingEnrollmentAttempt),
    enrollmentAttemptError: enrollmentAttemptError?.message || null,
    canOperateLocally: canAccessLocalPOS(agentAuthState, deviceTrustState),
    canRunSync: canRunSync(agentAuthState, deviceTrustState, deviceProofReady && serverHasActiveCredential),
    serverHasActiveCredential,
    deviceProofReady,
    lastCursor: db ? getCursor(db) : status.lastCursor,
    productCount: db ? Number(db.prepare('SELECT count(*) AS n FROM products WHERE deleted_at IS NULL AND is_active = 1').get().n) : 0,
    outboxPending: outbox.pending,
    outboxFailed: outbox.failed,
  };
}

async function pullAll() {
  const token = requireDeviceToken();
  let cursor = getCursor(db);
  let pages = 0;
  let productsProcessed = 0;
  while (true) {
    if (++pages > 1000) throw new Error('Pull stopped after 1000 pages; check API pagination.');
    const response = await pullChanges({
      baseUrl: process.env.EDEN_SYNC_URL,
      token,
      lastPulledAt: cursor,
      deviceId: deviceCredential?.deviceId,
      privateKeyPem: deviceCredential?.privateKeyPem,
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
  const response = await pushChanges({
    baseUrl: process.env.EDEN_SYNC_URL,
    token: requireDeviceToken(),
    deviceId: deviceCredential?.deviceId,
    privateKeyPem: deviceCredential?.privateKeyPem,
    idempotencyKey: batch.idempotencyKey,
    payload: batch.payload,
  });
  const result = applyPushResponse(db, batch, response);
  console.log(`[sync] push batch=${batch.idempotencyKey}; acknowledged=${result.acknowledged}; retained=${result.retained}; replay=${result.replay}`);
  return { sent: true, ...result };
}

async function doSync() {
  if (!canRunSync(agentAuthState, deviceTrustState, deviceProofReady && serverHasActiveCredential)) {
    syncState = deviceTrustState === 'revoked' ? 'blocked_revoked'
      : deviceTrustState === 'rejected' ? 'blocked_rejected'
      : deviceTrustState === 'deactivated' ? 'blocked_deactivated'
      : deviceTrustState === 'awaiting_approval' ? 'blocked_unapproved'
      : deviceTrustState === 'approved' ? 'blocked_proof_unavailable'
      : 'blocked_unregistered';
    const message = deviceTrustState === 'revoked'
      ? 'Terminal révoqué : synchronisation désactivée. Les opérations locales sont conservées.'
      : deviceTrustState === 'rejected'
        ? 'Enrôlement du terminal rejeté : synchronisation désactivée. Les opérations locales sont conservées.'
        : deviceTrustState === 'deactivated'
          ? 'Terminal désactivé : synchronisation suspendue. Les opérations locales sont conservées.'
          : deviceTrustState === 'awaiting_approval'
            ? 'Terminal en attente d’approbation : synchronisation suspendue. La caisse locale reste disponible.'
            : deviceTrustState === 'approved'
              ? 'Terminal approuvé par le serveur, mais la preuve ES256 côté client n’est pas encore activée. Synchronisation suspendue.'
              : 'Terminal non enregistré : synchronisation suspendue. La caisse locale reste disponible.';
    status = { ...status, state: 'pending', message };
    windowRef?.webContents.send('eden:status', readStatus());
    return readStatus();
  }
  if (status.state === 'syncing') return readStatus();
  syncState = 'syncing';
  status = { ...status, state: 'syncing', message: 'Synchronisation en cours…' };
  windowRef?.webContents.send('eden:status', readStatus());

  try {
    // Pull reference data first (products, staff, sessions) before pushing queued sales.
    const initialPull = await pullAll();
    const push = await pushPending();
    // Pull once more to receive authoritative versions and server-assigned sync sequences.
    const finalPull = push.sent ? await pullAll() : initialPull;
    const outbox = getOutboxStatus(db);
    syncState = 'idle';
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
    syncState = 'paused_offline';
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

function startDeviceStatusPolling() {
  if (!deviceToken || !deviceCredential?.deviceId) return;
  if (!deviceStatusService) {
    deviceStatusService = new DeviceStatusService({
      baseUrl: process.env.EDEN_SYNC_URL,
      getAgentToken: () => deviceToken,
      getDeviceId: () => deviceCredential?.deviceId || null,
      onStatus: (serverStatus) => {
        serverHasActiveCredential = serverStatus.hasActiveCredential;
        deviceTrustState = !serverStatus.isActive ? 'deactivated' : serverStatus.approvalStatus === 'pending_approval'
          ? 'awaiting_approval' : serverStatus.approvalStatus;
        syncState = deviceTrustState === 'revoked' ? 'blocked_revoked'
          : deviceTrustState === 'rejected' ? 'blocked_rejected'
          : deviceTrustState === 'deactivated' ? 'blocked_deactivated'
          : deviceTrustState === 'awaiting_approval' ? 'blocked_unapproved'
          : deviceTrustState === 'approved' ? 'blocked_proof_unavailable'
          : 'blocked_unregistered';
        status = {
          ...status,
          state: 'pending',
          message: deviceTrustState === 'approved'
            ? 'Approbation serveur confirmée. La synchronisation attend l’activation du protocole de preuve ES256.'
            : `Statut serveur du terminal : ${serverStatus.approvalStatus}.`,
        };
        windowRef?.webContents.send('eden:status', readStatus());
        if (canRunSync(agentAuthState, deviceTrustState, deviceProofReady && serverHasActiveCredential)) {
          void doSync();
        }
      },
    });
  }
  deviceStatusService.startPolling(30000);
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
  // Read-only device metadata only. The private key and safeStorage never cross IPC.
  registerTrustedHandler('eden:device:get-status', () => ({
    isEnrolled: Boolean(deviceCredential?.deviceId),
    deviceId: deviceCredential?.deviceId || null,
    thumbprint: deviceCredential?.thumbprint || null,
    trustState: deviceTrustState,
    syncState,
    canOperateLocally: canAccessLocalPOS(agentAuthState, deviceTrustState),
    canRunSync: canRunSync(agentAuthState, deviceTrustState, deviceProofReady && serverHasActiveCredential),
    serverHasActiveCredential,
    deviceProofReady,
  }));
  registerTrustedHandler('eden:device:check-status', async () => {
    if (!deviceStatusService) return { success: false, reason: 'DEVICE_STATUS_NOT_CONFIGURED' };
    return deviceStatusService.checkStatus();
  });
  registerTrustedHandler('eden:device:enroll', async (credentials) => {
    try {
      credentials = validateEnrollmentCredentials(credentials);
    } catch (error) {
      return { success: false, error: error.message || 'Identifiants d’enrôlement invalides.' };
    }
    if (tokenStoreError || authState === 'storage-error') {
      return { success: false, error: 'Le stockage sécurisé est indisponible. L’enrôlement est bloqué.' };
    }
    if (deviceToken) return { success: false, error: 'Cette caisse est déjà enrôlée.' };

    let token;
    try {
      token = validateDeviceToken(credentials?.token);
    } catch (error) {
      return { success: false, error: error.message || 'JWT invalide.' };
    }

    try {
      await tokenStore.setToken(token);
      const storedToken = await tokenStore.load();
      if (storedToken !== token) throw new Error('La vérification du stockage sécurisé a échoué.');
      deviceToken = storedToken;
      tokenStoreError = null;
      agentAuthState = 'authenticated';
      authState = 'ready';
      authMessage = 'Session agent chargée depuis le stockage sécurisé.';
      status = { ...status, state: 'pending', message: 'Session agent ouverte. La caisse locale est disponible ; le terminal doit encore être enregistré et approuvé pour synchroniser.', lastCursor: getCursor(db) };
      windowRef?.webContents.send('eden:status', readStatus());
      startDeviceStatusPolling();
      // Local POS is available; sync remains blocked until server approval and the ES256 client proof protocol are ready.
      return { success: true };
    } catch (error) {
      tokenStoreError = error;
      authState = 'storage-error';
      authMessage = 'Impossible de confirmer le stockage chiffré. La synchronisation reste bloquée.';
      windowRef?.webContents.send('eden:status', readStatus());
      console.error('[auth] enrollment storage failed:', error.message);
      return { success: false, error: authMessage };
    }
  });

  registerTrustedHandler('eden:device:register', async (input) => {
    let enrollment;
    try {
      enrollment = validateDeviceEnrollmentInput(input);
    } catch (error) {
      return { success: false, error: error.message || 'Données d’enrôlement invalides.' };
    }
    if (!deviceToken || agentAuthState !== 'authenticated') {
      return { success: false, error: 'Une session agent valide doit être enregistrée avant l’enrôlement du terminal.' };
    }
    if (tokenStoreError || deviceCredentialError || enrollmentAttemptError) {
      return { success: false, error: 'Le stockage sécurisé est indisponible. L’enrôlement est bloqué.' };
    }
    if (deviceCredential?.deviceId) {
      return { success: false, error: 'Ce terminal possède déjà une credential. Aucun nouvel enrôlement ne sera lancé.' };
    }
    if (!credentialStore || !enrollmentAttemptStore) {
      return { success: false, error: 'Le stockage sécurisé des credentials est indisponible.' };
    }

    try {
      let attempt = pendingEnrollmentAttempt;
      if (attempt) {
        if (attempt.activationCode !== enrollment.activationCode) {
          return {
            success: false,
            code: 'PENDING_ENROLLMENT_MISMATCH',
            error: 'Une tentative chiffrée est déjà en attente. Réutilisez le même code d’activation pour reprendre exactement cette preuve.',
          };
        }
      } else {
        const keyPair = generateDeviceKeyPair();
        const hardwareInfo = getDeviceHardwareInfo();
        const fingerprint = getDeviceFingerprint(hardwareInfo);
        attempt = {
          activationCode: enrollment.activationCode,
          deviceName: enrollment.deviceName,
          hardwareInfo,
          fingerprint,
          privateKeyPem: keyPair.privateKeyPem,
          publicKeyPem: keyPair.publicKeyPem,
          thumbprint: keyPair.thumbprint,
          algorithm: 'ES256',
          jti: crypto.randomUUID(),
        };
        // Persist the exact key, jti and activation binding before any network call.
        // A lost response can then be retried idempotently with a fresh iat.
        await enrollmentAttemptStore.save(attempt);
        pendingEnrollmentAttempt = attempt;
      }

      // Refresh iat on each attempt while preserving the same durable jti/key.
      // This supports retries after the server's ±60-second proof window.
      const initialProof = createInitialEnrollmentProof({
        privateKeyPem: attempt.privateKeyPem,
        activationCode: attempt.activationCode,
        fingerprint: attempt.fingerprint,
        jti: attempt.jti,
      });
      // Re-save before network I/O so the exact enrollment identity survives a crash.
      await enrollmentAttemptStore.save(attempt);

      const serverEnrollment = await enrollDeviceWithProof({
        baseUrl: process.env.EDEN_SYNC_URL,
        activationCode: attempt.activationCode,
        deviceName: attempt.deviceName,
        hardwareInfo: attempt.hardwareInfo,
        fingerprint: attempt.fingerprint,
        publicKeyPem: attempt.publicKeyPem,
        initialProof,
        expectedThumbprint: attempt.thumbprint,
      });

      const credential = {
        deviceId: serverEnrollment.deviceId,
        privateKeyPem: attempt.privateKeyPem,
        publicKeyPem: attempt.publicKeyPem,
        thumbprint: attempt.thumbprint,
        algorithm: 'ES256',
      };
      await credentialStore.save(credential);
      const storedCredential = await credentialStore.load();
      if (!storedCredential || storedCredential.deviceId !== serverEnrollment.deviceId ||
          storedCredential.thumbprint !== attempt.thumbprint) {
        throw new Error('La vérification de la credential chiffrée a échoué.');
      }

      deviceCredential = storedCredential;
      deviceCredentialError = null;
      deviceProofReady = Boolean(storedCredential.deviceId && storedCredential.privateKeyPem && storedCredential.algorithm === 'ES256');
      serverHasActiveCredential = true;
      // Never infer approval from the enrollment response. The status endpoint
      // is queried immediately and remains the only source of trust transitions.
      deviceTrustState = 'awaiting_approval';
      syncState = 'blocked_unapproved';
      status = {
        ...status,
        state: 'pending',
        message: 'Terminal enregistré cryptographiquement. Vérification du statut serveur et approbation administrative en cours ; la caisse locale reste disponible.',
      };
      startDeviceStatusPolling();
      windowRef?.webContents.send('eden:status', readStatus());
      try {
        await enrollmentAttemptStore.clear();
        pendingEnrollmentAttempt = null;
      } catch (cleanupError) {
        // The credential is already safely persisted. Startup will retry cleanup.
        console.error('[device] pending enrollment cleanup deferred:', cleanupError.message);
      }
      return {
        success: true,
        deviceId: serverEnrollment.deviceId,
        approvalStatus: serverEnrollment.approvalStatus,
        keyThumbprint: serverEnrollment.keyThumbprint,
      };
    } catch (error) {
      console.error('[device] initial proof enrollment failed:', error.message);
      const definitiveRejections = new Set([
        'INVALID_ACTIVATION_CODE',
        'CODE_ALREADY_CONSUMED',
        'CODE_EXPIRED',
        'PROOF_BINDING_MISMATCH',
        'INVALID_INITIAL_PROOF_SIGNATURE',
        'INITIAL_PROOF_HTM_HTU_MISMATCH',
      ]);
      if (error.status === 401 && definitiveRejections.has(error.code)) {
        try {
          await enrollmentAttemptStore.clear();
          pendingEnrollmentAttempt = null;
        } catch (cleanupError) {
          console.error('[device] rejected pending attempt cleanup failed:', cleanupError.message);
        }
      }
      return {
        success: false,
        error: error.message || 'Enrôlement cryptographique impossible.',
        code: error.code || null,
        statusCode: error.status || null,
        retryable: Boolean(pendingEnrollmentAttempt),
      };
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
  startDeviceStatusPolling();
  await doSync();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  deviceStatusService?.stopPolling();
  if (db) db.close();
});
